"""The last pipeline stage: keep a finished song's stems as WAV or MP3
(upstream PR 822, with the durability of upstream PR 898).

Separation and every analysis stage run on WAV exactly as they always did.
Only once the song has nothing left to read from its stems does this stage
look at the Stem storage format setting (read now, so a change applies to the
next song without a restart):

- WAV, the default: nothing is touched. The job records "wav".
- MP3: every stem file (the six stems, the split pair, original, mix) is
  encoded to a dot temp beside it, verified (app/pipeline/stem_verify.py) and
  fsynced. Only when every stem passed are the MP3s renamed into place, the
  stems folder fsynced, and then the WAVs deleted: a power cut at any point
  leaves either the WAVs or MP3s that are whole on the disk.

Any failure removes the temps, keeps every WAV and records the song as "wav".
The song finishes either way. A cancel raises JobCancelled after the same
cleanup. Temps are named `.<name>.<hex>.mp3.tmp`, which the startup sweep of
crash leftovers (collect.sweep_crash_leftovers) removes.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from app.core.config import EXTRA_STEM_NAMES, STEM_FORMAT_MP3, STEM_FORMAT_WAV, STEM_NAMES
from app.core.models import Job, JobCancelled, _set
from app.core.settings import fsync_dir, fsync_file, get_stem_format, get_stem_mp3_kbps
from app.core.stem_files import MP3_EXT, WAV_EXT, stem_url
from app.pipeline.cancel import check_cancel
from app.pipeline.stem_verify import encode_mp3, verify_mp3

logger = logging.getLogger("stemdeck.pipeline")

# Every stem file a finished song can hold.
STORED_NAMES: tuple[str, ...] = (*STEM_NAMES, *EXTRA_STEM_NAMES, "original", "mix")
_STAGE = "Compressing stems..."
_TEMP_SUFFIX = ".tmp"
_BYTES_PER_MB = 1e6
# Kept beside the stems and valid while not older than the vocals stem
# (lyrics_align._envelope, GET /vocal-envelope).
_VOCAL_ENVELOPE_FILE = "vocal_envelope.json"


def temp_mp3_path(wav: Path) -> Path:
    """Where `wav`'s MP3 is written before it is verified: dot-prefixed and
    ending .tmp, so no reader takes it for a stem and the crash sweep finds it."""
    return wav.with_name(f".{wav.stem}.{uuid.uuid4().hex}{MP3_EXT}{_TEMP_SUFFIX}")


def store_stems(job: Job, job_dir: Path) -> bool:
    """Keep the song's stems in the format the setting asks for now. False,
    with nothing touched and no cancel looked at, when the setting is WAV.
    Never raises but for a cancel."""
    if get_stem_format() != STEM_FORMAT_MP3:
        _record(job, STEM_FORMAT_WAV, None)
        return False
    check_cancel(job)
    kbps = get_stem_mp3_kbps()
    stems_dir = job_dir / "stems"
    wavs = _wavs(stems_dir, STORED_NAMES)
    if not wavs:
        _record(job, STEM_FORMAT_WAV, None)
        return True
    _set(job, stage=_STAGE)
    started = time.monotonic()
    before = sum(_size(w) for w in wavs)
    vocals_stamp = _stamp(stems_dir / f"vocals{WAV_EXT}")
    if not _convert(job, wavs, kbps, lambda: job.cancel_requested):
        _record(job, STEM_FORMAT_WAV, None)
        return True
    _keep_derived_files(job_dir, vocals_stamp)
    _refresh_urls(job, stems_dir)
    _record(job, STEM_FORMAT_MP3, kbps)
    _log_stored(job, kbps, wavs, before, started)
    return True


def _log_stored(job: Job, kbps: int, wavs: list[Path], before: int, started: float) -> None:
    after = sum(_size(w.with_suffix(MP3_EXT)) for w in wavs)
    logger.info(
        "[%s] stems stored as MP3 %dk: %d files, %.1f MB -> %.1f MB in %.1fs",
        job.id,
        kbps,
        len(wavs),
        before / _BYTES_PER_MB,
        after / _BYTES_PER_MB,
        time.monotonic() - started,
    )


def store_split_stems(
    job: Job,
    stems_dir: Path,
    names: list[str],
    cancelled: Callable[[], bool],
) -> None:
    """The on-demand Lead + Backing split writes WAVs into a song that may be
    stored as MP3. They are stored the way the song is, with the same checks,
    and stay WAV on any failure. Never raises but for the split's cancel,
    with the WAVs kept."""
    wavs = _wavs(stems_dir, tuple(names))
    if job.stem_format != STEM_FORMAT_MP3 or not job.stem_mp3_kbps or not wavs:
        return
    _convert(job, wavs, job.stem_mp3_kbps, cancelled)


def _convert(job: Job, wavs: list[Path], kbps: int, stop: Callable[[], bool]) -> bool:
    """Every WAV to a verified MP3, then the WAVs deleted. False when the WAVs
    were kept, with nothing of the attempt left behind. Raises JobCancelled
    once `stop()` is true, before any WAV is deleted."""
    try:
        made = _encode_all(job, wavs, kbps, stop)
        _move_in(made)
    except JobCancelled:
        raise
    except Exception as exc:
        # StemStorageError, or anything unexpected (a full disk, libsndfile).
        logger.warning("[%s] stems kept as WAV: MP3 storage failed: %s", job.id, exc)
        return False
    fsync_dir(wavs[0].parent)
    for wav in wavs:
        try:
            wav.unlink()
        except OSError:
            # Harmless: a WAV left behind still wins over its MP3 (stem_path).
            logger.warning("[%s] could not delete %s after storing it as MP3", job.id, wav.name)
    return True


def _encode_all(
    job: Job,
    wavs: list[Path],
    kbps: int,
    stop: Callable[[], bool],
) -> list[tuple[Path, Path]]:
    made: list[tuple[Path, Path]] = []
    try:
        for wav in wavs:
            _check_stop(stop)
            tmp = temp_mp3_path(wav)
            made.append((wav, tmp))
            encode_mp3(job, wav, tmp, kbps)
            verify_mp3(job, wav, tmp)
            fsync_file(tmp)
        _check_stop(stop)
    except BaseException:
        _discard(tmp for _wav, tmp in made)
        raise
    return made


def _check_stop(stop: Callable[[], bool]) -> None:
    if stop():
        raise JobCancelled()


def _move_in(made: list[tuple[Path, Path]]) -> None:
    moved: list[Path] = []
    try:
        for wav, tmp in made:
            final = wav.with_suffix(MP3_EXT)
            os.replace(tmp, final)
            moved.append(final)
    except OSError:
        _discard([*(tmp for _wav, tmp in made), *moved])
        raise


def _discard(paths) -> None:
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("could not remove %s", path.name)


def _wavs(stems_dir: Path, names: tuple[str, ...]) -> list[Path]:
    return [p for p in (stems_dir / f"{n}{WAV_EXT}" for n in names) if p.is_file()]


def _record(job: Job, fmt: str, kbps: int | None) -> None:
    _set(job, stem_format=fmt, stem_mp3_kbps=kbps)


def _refresh_urls(job: Job, stems_dir: Path) -> None:
    """Point the job's stem URLs, and the mix link when it is a stem file, at
    the files now on disk."""
    stems = [
        {**entry, "url": stem_url(job.id, stems_dir, entry["name"])} if entry.get("name") else entry
        for entry in job.stems
    ]
    prefix = f"/api/jobs/{job.id}/stems/"
    mix_url = job.mix_url
    if mix_url and mix_url.startswith(prefix):
        name = Path(mix_url[len(prefix) :]).stem
        if name in STORED_NAMES:
            mix_url = stem_url(job.id, stems_dir, name)
    _set(job, stems=stems, mix_url=mix_url)


def _keep_derived_files(job_dir: Path, vocals_wav_stamp: list[int] | None) -> None:
    """Files checked against the vocals stem's size and time hold the same
    audio in its new file, so they stay valid and are not recomputed."""
    stems_dir = job_dir / "stems"
    if vocals_wav_stamp is None or not (stems_dir / f"vocals{MP3_EXT}").is_file():
        return
    from app.pipeline.lyrics_retime import restamp_transcript

    restamp_transcript(job_dir, vocals_wav_stamp)
    envelope = stems_dir / _VOCAL_ENVELOPE_FILE
    try:
        if envelope.is_file() and envelope.stat().st_mtime_ns >= vocals_wav_stamp[1]:
            os.utime(envelope)
    except OSError:
        logger.info("[%s] could not keep the vocal envelope", job_dir.name, exc_info=True)


def _stamp(path: Path) -> list[int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return [st.st_size, st.st_mtime_ns]


def _size(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0
