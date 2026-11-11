from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
import uuid
from collections.abc import Iterable
from pathlib import Path

from app.core.config import (
    CACHE_TEMP_MIN_AGE_SECONDS,
    DEMUCS_MODEL,
    FAILED_TTL_SECONDS,
    JOB_TTL_SECONDS,
    STEM_NAMES,
    TIMEOUT_FFMPEG,
    ffmpeg_executable,
)
from app.core.models import FINISHED_STATUSES, STATUS_STOPPED, VOCAL_SPLIT_RUNNING, Job
from app.core.registry import all_jobs as registry_all
from app.core.registry import persist as registry_persist
from app.core.registry import remove as registry_remove
from app.core.registry import set_proc
from app.core.setlists import all_song_ids as setlists_all_song_ids
from app.core.song_folder import holds_job_files, is_real_entry, job_dirs, quarantine_dirs
from app.pipeline.audio_stats import scan_stem
from app.pipeline.lyrics_retime import RETIME_RUNS
from app.pipeline.transcribe_on_demand import TRANSCRIBE_RUNS

logger = logging.getLogger("stemdeck.collect")


def _rmtree(path: Path) -> None:
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass
    except Exception:
        logger.warning("failed to remove %s", path, exc_info=True)


def _run_ffmpeg(job: Job, cmd: list[str]) -> bool:
    """Run an ffmpeg command, registering the subprocess with the job
    registry so POST /api/jobs/{id}/cancel can terminate it. Returns
    True on success, False on failure or external termination.

    Without registering the proc, an in-flight ffmpeg amix would block
    cancellation for up to its 300s timeout -- the cancel flag is set
    but the runner can't see it until subprocess.run returns. With
    set_proc, the cancel API can call proc.terminate() directly and
    communicate() returns within ~1s with a non-zero returncode."""
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    set_proc(job.id, proc)
    try:
        try:
            _, stderr = proc.communicate(timeout=TIMEOUT_FFMPEG)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()
            logger.warning("ffmpeg timed out for job %s", job.id)
            return False
        if proc.returncode != 0:
            tail = (stderr or b"").decode(errors="replace").splitlines()[-3:]
            logger.warning(
                "ffmpeg exit %s for job %s: %s",
                proc.returncode,
                job.id,
                " | ".join(tail) or "(no stderr)",
            )
            return False
        return True
    finally:
        set_proc(job.id, None)


def _write_wav(job: Job, cmd: list[str], out: Path) -> Path | None:
    """Run `cmd` with a WAV output at the dot temp name `.<name>.<hex>.tmp`
    beside `out`, renamed to `out` only once ffmpeg succeeded. A kill mid-write
    then leaves a temp file, never an `out` that a rebuild takes for a whole
    stem (upstream PR 898)."""
    tmp = out.with_name(f".{out.name}.{uuid.uuid4().hex}.tmp")
    try:
        if not _run_ffmpeg(job, [*cmd, "-f", "wav", str(tmp)]):
            return None
        os.replace(tmp, out)
        return out
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            logger.warning("could not remove %s", tmp, exc_info=True)


def remove_job_dir(job_dir: Path) -> bool:
    """Remove a job's directory. False means files are still on disk.

    Retried once: on macOS the common failure is Finder or Spotlight creating
    a .DS_Store between rmtree's scan and its final rmdir, which leaves
    "Directory not empty" on a directory that is about to be empty again. On
    Windows it is a handle a process that just exited has not quite let go of,
    which is what the runner's cancel path meets right after terminating
    ffmpeg or the demucs worker (#749). Shared by delete_job and that path."""
    for attempt in (1, 2):
        if not job_dir.is_dir():
            return True
        try:
            shutil.rmtree(job_dir)
            return True
        except Exception:
            logger.warning(
                "failed to remove job dir %s (attempt %d)", job_dir, attempt, exc_info=True
            )
    return not job_dir.is_dir()


_TERMINAL = FINISHED_STATUSES


def collect(job: Job, stems_root: Path, job_dir: Path) -> list[str]:
    """Move Demucs-emitted stems into the job's stems/ dir and clean up
    the demucs intermediate dir. Does NOT delete the source download --
    cleanup_source() is called by the runner, for the jobs whose source
    can be fetched again, after any post-processing that needs to
    re-encode it (e.g. building original.wav)."""
    target_dir = job_dir / "stems"
    target_dir.mkdir(exist_ok=True)
    found: list[str] = []
    for name in STEM_NAMES:
        src = stems_root / f"{name}.wav"
        if src.exists():
            shutil.move(str(src), target_dir / f"{name}.wav")
            found.append(name)
    _rmtree(job_dir / DEMUCS_MODEL)
    if not found:
        raise RuntimeError("no stems produced by demucs")
    return found


def cleanup_source(job_dir: Path) -> None:
    """Delete the source audio file. Called after collect AND after any
    post-processing that re-encodes the source (make_original_track).
    The source is 100-300 MB, so getting rid of it is the bulk of disk
    reclaim per job; only the stems remain.

    Not called for uploads. The runner decides: a link can be fetched
    again, an upload cannot, and deleting an upload's source destroys
    the only copy StemDeck has of it."""
    for f in job_dir.glob("source.*"):
        f.unlink(missing_ok=True)


def make_original_track(job: Job, job_dir: Path, stems_dir: Path) -> Path | None:
    """Build the "Original" backing track at stems/original.wav as the
    sum of the stems the user did NOT select. This way the studio can
    play (original + each selected stem) and reconstruct the full song
    without doubling the selected stems -- which is what would happen
    if "original" were the raw source download (drum hits in original
    + isolated drums.wav = drums at 2x amplitude).

    Skipped when the user kept all 6 stems (no complement to mix) or
    when none of the unselected stem WAVs are on disk."""
    unselected = [s for s in STEM_NAMES if s not in job.selected_stems]
    inputs = [stems_dir / f"{name}.wav" for name in unselected]
    inputs = [p for p in inputs if p.exists()]
    if not inputs:
        return None
    out = stems_dir / "original.wav"
    cmd: list[str] = [
        ffmpeg_executable(),
        "-y",
        "-nostdin",
        "-loglevel",
        "error",
    ]
    for p in inputs:
        cmd += ["-i", str(p)]
    if len(inputs) == 1:
        # Single complement stem -- copy as-is so we still produce a
        # canonical mix.wav-shaped output without invoking amix on a
        # 1-input graph (which is a no-op anyway).
        cmd += ["-c:a", "pcm_s16le"]
    else:
        filter_inputs = "".join(f"[{i}:a]" for i in range(len(inputs)))
        cmd += [
            "-filter_complex",
            f"{filter_inputs}amix=inputs={len(inputs)}:normalize=0",
            "-c:a",
            "pcm_s16le",
        ]
    return _write_wav(job, cmd, out)


def make_selected_mix(job: Job, stems_dir: Path, found: list[str]) -> Path | None:
    """If the user picked a strict subset of stems at submit time,
    sum those stems with ffmpeg amix into mix.wav. Returns the output
    path on success, or None when there's nothing to mix.

    Returns the existing single stem path (no ffmpeg) if exactly one
    stem was selected -- copying it to mix.wav would be 30 MB of
    duplicate data. The caller uses the returned path's name for the
    download URL, so a single-stem selection points the Download Mix
    button directly at the existing stem file.

    amix normalize=0 keeps stem amplitudes as-is. Demucs separations
    sum back to (close to) the original signal, so a 2-stem subset
    fits comfortably below 0 dBFS without normalization headroom."""
    selected = [s for s in job.selected_stems if s in found]
    if not selected:
        return None
    if len(selected) == 1:
        return stems_dir / f"{selected[0]}.wav"
    inputs = [stems_dir / f"{name}.wav" for name in selected]
    out = stems_dir / "mix.wav"
    cmd: list[str] = [
        ffmpeg_executable(),
        "-y",
        "-nostdin",
        "-loglevel",
        "error",
    ]
    for p in inputs:
        cmd += ["-i", str(p)]
    filter_inputs = "".join(f"[{i}:a]" for i in range(len(inputs)))
    cmd += [
        "-filter_complex",
        f"{filter_inputs}amix=inputs={len(inputs)}:normalize=0",
        "-c:a",
        "pcm_s16le",
    ]
    return _write_wav(job, cmd, out)


# Enough points to back the deepest zoom, not the 1x bar count: a full-width
# panel draws about 2400 bars at WAVE_ZOOM_MAX (10x, transport.js), and past
# the point count the bars repeat their neighbours instead of revealing
# anything. Raise this and WAVE_ZOOM_MAX together.
_PEAK_POINTS = 3000


def compute_stem_peaks(stems_dir: Path, stem_names: list[str]) -> dict[str, float]:
    """Compute and cache [min, max] waveform peaks for each stem via a single
    streamed pass per file (#286), and return each stem's RMS from that same
    pass so the caller can derive stem presence without a second decode
    (#287). Peaks failure is non-fatal — missing peaks.json degrades to
    client-side decode; a stem missing from the returned dict is simply
    excluded from presence."""
    peaks: dict[str, list[list[float]]] = {}
    rms_values: dict[str, float] = {}
    for name in stem_names:
        path = stems_dir / f"{name}.wav"
        if not path.is_file():
            continue
        try:
            result, rms = scan_stem(path, _PEAK_POINTS)
            if not result:
                continue
            peaks[name] = result
            rms_values[name] = rms
        except Exception:
            logger.warning("could not compute peaks for %s/%s", stems_dir.name, name, exc_info=True)

    if peaks:
        try:
            tmp = stems_dir / "peaks.json.tmp"
            tmp.write_text(json.dumps(peaks), encoding="utf-8")
            tmp.replace(stems_dir / "peaks.json")
        except Exception:
            logger.warning("could not write peaks.json for %s", stems_dir.name, exc_info=True)

    return rms_values


def merge_stem_peaks(stems_dir: Path, new_names: list[str]) -> dict[str, float]:
    """Add peaks/RMS for newly-produced stems (e.g. the on-demand lead/backing
    vocal split, #275) into the existing peaks.json instead of recomputing
    every stem. Best-effort, same as compute_stem_peaks: a failure here only
    costs client-side waveform decode for the new stems, never the job.

    Returns each scanned stem's RMS, from the same pass, so the caller can
    extend stem presence without decoding anything twice (see
    presence_for_split)."""
    path = stems_dir / "peaks.json"
    peaks: dict[str, list[list[float]]] = {}
    rms_values: dict[str, float] = {}
    if path.is_file():
        try:
            peaks = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.warning("could not read existing peaks.json in %s", stems_dir, exc_info=True)

    for name in new_names:
        wav = stems_dir / f"{name}.wav"
        if not wav.is_file():
            continue
        try:
            result, rms = scan_stem(wav, _PEAK_POINTS)
            rms_values[name] = rms
            if result:
                peaks[name] = result
        except Exception:
            logger.warning("could not compute peaks for %s/%s", stems_dir.name, name, exc_info=True)

    try:
        tmp = stems_dir / "peaks.json.tmp"
        tmp.write_text(json.dumps(peaks), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        logger.warning("could not write peaks.json for %s", stems_dir.name, exc_info=True)

    return rms_values


def presence_for_split(
    rms_values: dict[str, float],
    stem_presence: dict[str, int] | None,
    *,
    reference: str = "vocals",
) -> dict[str, int]:
    """Put the lead/backing stems on the same 0-100 scale the pipeline already
    recorded for the base six.

    Presence is a stem's RMS as a percentage of the loudest stem in the job,
    and that loudest value is not stored anywhere -- only the percentages are.
    It can be recovered exactly from any stem whose presence is known:

        loudest = rms[reference] / (presence[reference] / 100)

    So scanning the reference stem alongside the new ones is enough, and the
    alternative (re-decoding all eight stems to renormalise) is avoided.

    Returns an empty dict when the reference is missing or silent, which leaves
    the new cards reading "--" rather than showing a number derived from
    nothing."""
    reference_rms = rms_values.get(reference)
    reference_pct = (stem_presence or {}).get(reference)
    if not reference_rms or not reference_pct:
        return {}
    loudest = reference_rms / (reference_pct / 100)
    if loudest < 1e-9:
        return {}
    return {
        name: max(0, min(100, round(rms / loudest * 100)))
        for name, rms in rms_values.items()
        if name != reference
    }


_NEWER_THAN_CUTOFF = "newer than the cutoff"


def _work_running(job: Job) -> bool:
    """Whether a vocal split, lyrics timing or transcription is running on a
    finished song: the run boards delete stops before it removes the folder."""
    # Imported here: vocal_split imports this module.
    from app.pipeline.vocal_split import VOCAL_SPLIT_RUNS

    # A failed split leaves its board before its error is recorded on the job.
    if job.vocal_split == VOCAL_SPLIT_RUNNING:
        return True
    return any(board.running(job.id) for board in (VOCAL_SPLIT_RUNS, RETIME_RUNS, TRANSCRIBE_RUNS))


def _keep_reason(
    job: Job | None,
    job_dir: Path,
    cutoff: float,
    in_setlists: set[str],
) -> str | None:
    """Why the sweep must leave `job_dir` alone, or None to remove it. Age is
    asked first, so any other reason is one that kept a song past the cutoff."""
    # The registry is rebuilt at start, so a leftover dir goes by its mtime.
    try:
        stamp = job_dir.stat().st_mtime if job is None else job.created_at
    except OSError:
        return "folder cannot be read"
    if stamp >= cutoff:
        return _NEWER_THAN_CUTOFF
    if job_dir.name in in_setlists:
        return "in a setlist"
    if job is None:
        return _unregistered_keep_reason(job_dir)
    if job.status not in _TERMINAL:
        return "still active"
    if _work_running(job):
        return "work is running on it"
    if job.status == STATUS_STOPPED:
        # Never separated, and an upload's kept source is its only copy.
        return "stopped song"
    if job.favorite:
        return "favourite"
    return None


def _unregistered_keep_reason(job_dir: Path) -> str | None:
    """A folder restore() did not adopt goes only when it is StemDeck's and holds
    no audio: one with a source or stems may be the only copy of an upload."""
    if not holds_job_files(job_dir):
        return "holds nothing StemDeck writes"
    try:
        if any(p.is_file() for p in job_dir.glob("source.*")):
            return "unregistered folder holds a source file"
        if any((job_dir / "stems").glob("*.wav")):
            return "unregistered folder holds stems"
    except OSError:
        return "folder cannot be read"
    return None


def _log_kept(job_id: str, reason: str) -> None:
    """Every keep, at INFO when it held back a song past the cutoff."""
    level = logging.DEBUG if reason == _NEWER_THAN_CUTOFF else logging.INFO
    logger.log(level, "auto-delete kept %s: %s", job_id, reason)


def sweep_old_jobs(jobs_dir: Path, ttl_seconds: int | None = None) -> None:
    """Delete job directories older than `ttl_seconds` (JOB_TTL_SECONDS when
    not given) and remove them from the in-memory registry. Called hourly from
    the background sweep loop started at app startup, and only when the user
    has asked for automatic deletion -- deciding *whether* to sweep is the
    caller's job, this one only decides what is old.

    Prefers Job.created_at over directory mtime (which can be touched by
    unrelated filesystem events), and never deletes the directory of an
    active (non-terminal) registered job even if its timestamp looks old.
    Falls back to mtime for orphan directories left over from a previous
    server run, since the registry is in-memory only.

    Favourites and songs in any setlist are kept however old they are: the
    user has said they want them, which outranks a retention limit. When the
    setlists cannot be read, nothing is swept. A stopped song is never swept
    either, nor a song with a vocal split, lyrics timing or transcription
    running (upstream PR 862 and 998): only the user deletes those. Only StemDeck's own job
    folders are looked at, and one with no registry entry is kept while it holds a
    source or stems (upstream PR 886 and 889). Every song
    kept or removed is logged with the reason (_keep_reason)."""
    cutoff = time.time() - (JOB_TTL_SECONDS if ttl_seconds is None else ttl_seconds)
    if not jobs_dir.is_dir():
        return
    in_setlists = setlists_all_song_ids(jobs_dir)
    if in_setlists is None:
        logger.warning("setlists unreadable; skipping the retention sweep so no listed song goes")
        return
    jobs = registry_all()
    removed = False
    # Only StemDeck's own folders: the jobs folder may be shared. Not failed/,
    # whose quarantine has its own TTL (sweep_failed_jobs).
    for d in job_dirs(jobs_dir):
        job = jobs.get(d.name)
        reason = _keep_reason(job, d, cutoff, in_setlists)
        if reason is not None:
            _log_kept(d.name, reason)
            continue
        status = job.status if job is not None else "unregistered"
        logger.info(
            "auto-delete removed %s (%s): older than the cutoff, nothing keeps it", d.name, status
        )
        _rmtree(d)
        registry_remove(d.name)
        removed = True
    if removed:
        registry_persist(jobs_dir)


def sweep_failed_jobs(jobs_dir: Path) -> None:
    """Expire quarantined failure-evidence dirs (jobs/failed/<id>) older than
    FAILED_TTL_SECONDS. Runs unconditionally from the hourly sweep loop --
    unlike the job TTL sweep, which persistent-library deployments disable,
    failure evidence must never accumulate forever (#277)."""
    cutoff = time.time() - FAILED_TTL_SECONDS
    # Only StemDeck's quarantines: failed/ may hold someone else's folders.
    for d in quarantine_dirs(jobs_dir):
        try:
            if d.stat().st_mtime < cutoff:
                _rmtree(d)
        except OSError:
            logger.warning("failed-quarantine sweep could not stat %s", d, exc_info=True)


# What a writer leaves when the process dies before its own cleanup runs: a
# metadata.json write in the song folder (song_folder.write_json_atomic), and
# in stems/ a mix (_write_wav), a cached MP3 (stems._ensure_cached_mp3), the
# completion marker or the Lead + Backing work folder (vocal_split). Nothing a
# song keeps has one of these names.
_JOB_TEMP_FILE_RE = re.compile(r"\..+\.[0-9a-f]{32}\.tmp\Z")
_STEMS_TEMP_RE = re.compile(r"\..+\.tmp\Z")
# The same in the export caches: a render or a click written beside its cache
# entry, a stems zip and the folder its stems are transcoded in.
_CACHE_TEMP_DIR_RE = re.compile(r"\.zipwork-\w{8}\Z")
_CACHE_TEMP_FILE_RE = re.compile(r"\..+\.[0-9a-f]{32}\.tmp(\.\w+)?\Z|\.stemdeck_zip_\w{8}\.zip\Z")


def _matching(folder: Path, dir_re: re.Pattern[str], file_re: re.Pattern[str]) -> list[Path]:
    if not folder.is_dir() or not is_real_entry(folder):
        return []
    return [
        p
        for p in folder.iterdir()
        if (dir_re.match(p.name) and p.is_dir()) or (file_re.match(p.name) and p.is_file())
    ]


def _song_leftovers(jobs_dir: Path) -> list[Path]:
    found: list[Path] = []
    for job_dir in job_dirs(jobs_dir):
        if not holds_job_files(job_dir):
            continue
        try:
            found += [p for p in job_dir.iterdir() if _JOB_TEMP_FILE_RE.match(p.name)]
            found += _matching(job_dir / "stems", _STEMS_TEMP_RE, _STEMS_TEMP_RE)
        except OSError:
            logger.warning("crash leftover sweep could not read %s", job_dir.name)
    return found


def _cache_leftovers(cache_dirs: Iterable[Path]) -> list[Path]:
    cutoff = time.time() - CACHE_TEMP_MIN_AGE_SECONDS
    found: list[Path] = []
    for cache_dir in cache_dirs:
        try:
            found += [
                p
                for p in _matching(cache_dir, _CACHE_TEMP_DIR_RE, _CACHE_TEMP_FILE_RE)
                if p.stat().st_mtime < cutoff
            ]
        except OSError:
            logger.warning("crash leftover sweep could not read %s", cache_dir.name)
    return found


def sweep_crash_leftovers(jobs_dir: Path, cache_dirs: Iterable[Path]) -> int:
    """Remove what a killed process left half-written in every song folder and
    in the export caches (`cache_dirs`), upstream PR 900. Returns how many went.

    Call this at startup only, before the queue runs anything: no writer is
    alive then, so every temp found is dead. Only StemDeck's song folders are
    looked in, and no link is followed or removed. A cache temp written in the
    last CACHE_TEMP_MIN_AGE_SECONDS is left alone: it may be another server's."""
    gone = 0
    for path in _song_leftovers(jobs_dir) + _cache_leftovers(cache_dirs):
        if not is_real_entry(path):
            continue
        try:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            gone += 1
        except OSError:
            logger.warning("crash leftover not removed: %s", path.name)
    return gone
