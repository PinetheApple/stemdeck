"""Extracting the stems a finished song is missing, for POST
.../versions/extract.

The song's kept audio is separated again behind the pipeline lock, as a run of
its own kind (EXTRACT_RUNS). A link song keeps no audio, so its audio is
fetched again from the link by the import's downloader, into the run's temp
folder, and goes with it. Only stems the song has no file for are moved in,
so no file the player is using is replaced. The separator gets a scratch Job
with the song's id, never registered, so the song stays "done". Nothing of the
song changes unless the whole run succeeds, and nothing about a run is
persisted. The separator writes into a dot temp folder in stems/, which the
startup sweep removes after a crash.
"""

from __future__ import annotations

import logging
import os
import shutil
import urllib.parse
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

from app.core.models import STATUS_DONE, Job, JobCancelled, _set
from app.core.registry import get as registry_get
from app.core.song_folder import metadata_lock
from app.core.stem_files import MP3_EXT, WAV_EXT, point_urls_at_disk, stem_exists
from app.pipeline.collect import merge_stem_peaks, presence_for_split
from app.pipeline.download import download
from app.pipeline.errors import (
    CAUSE_SOURCE_BLOCKED,
    CAUSE_SOURCE_UNAVAILABLE,
    CAUSE_UNKNOWN,
    classify_failure,
)
from app.pipeline.runs import CANCELLED, DONE, IDLE, Run, RunBoard, run_behind_lock
from app.pipeline.separate import separate
from app.pipeline.stem_storage import store_split_stems

logger = logging.getLogger("stemdeck.pipeline")

PHASE_QUEUED = "queued"
PHASE_DOWNLOADING = "downloading"
PHASE_SEPARATING = "separating"
PHASE_FINISHING = "finishing"

# The separator ran but made no file for a stem: a model without that stem.
EXTRACT_FAILED_NO_OUTPUT = "no-output"
# The song reached its version limit while the stems were being made.
EXTRACT_FAILED_TOO_MANY_VERSIONS = "too-many-versions"

_TEMP_PREFIX = ".extract."
_TEMP_SUFFIX = ".tmp"
_PROGRESS_DIGITS = 3
_PEAKS_FILE = "peaks.json"
_LINK_SCHEMES = frozenset({"http", "https"})
# classify_failure's causes that only a download's wording matches.
_LINK_ONLY_CAUSES = frozenset({CAUSE_SOURCE_BLOCKED, CAUSE_SOURCE_UNAVAILABLE})

# Records the version once the stems are in, under the metadata lock: the
# song, the stems it shows and its name, returning the id of the version opened.
OpenVersion = Callable[[Job, list[str], str], str]
# The audio to separate: the song's kept file, or the link to fetch it from.
ExtractSource = Path | str


class ExtractFailed(Exception):
    """An extraction that failed for a reason of its own, in `code`."""

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class ExtractRun(Run):
    """One extraction: the missing `stems`, for the version showing `wanted`."""

    cancelled_state: ClassVar[str] = CANCELLED

    phase: str = PHASE_QUEUED
    stems: list[str] = field(default_factory=list)
    wanted: list[str] = field(default_factory=list)
    name: str = ""
    scratch: Job = field(default_factory=lambda: Job(id=""))
    error: str | None = None
    version_id: str | None = None


EXTRACT_RUNS: RunBoard[ExtractRun] = RunBoard(ExtractRun)


def _wav(folder: Path, name: str) -> Path:
    return folder / f"{name}{WAV_EXT}"


def _never_cancelled() -> bool:
    """Storing the stems as MP3 comes after the point of no cancel."""
    return False


def missing_stems(stems_dir: Path, wanted: list[str]) -> list[str]:
    return [name for name in wanted if not stem_exists(stems_dir, name)]


def link_of(song: Job) -> str | None:
    """The http(s) link the song was imported from, or None for an upload."""
    url = song.source_url or ""
    return url if urllib.parse.urlparse(url).scheme in _LINK_SCHEMES else None


def claim_extract(
    song: Job,
    missing: list[str],
    wanted: list[str],
    name: str,
) -> ExtractRun | None:
    """A new run for `song`, or None while one is going already."""
    run = EXTRACT_RUNS.claim(song.id)
    if run is not None:
        run.stems = missing
        run.wanted = wanted
        run.name = name
        run.scratch = Job(id=song.id)
    return run


def _fetch(run: ExtractRun, url: str, work: Path) -> Path:
    """The link's audio, downloaded into `work`. A failed download fails the
    run with its own cause, never separating anything."""
    run.phase = PHASE_DOWNLOADING
    try:
        return download(run.scratch, url, work, video=False)
    except JobCancelled:
        raise
    except Exception as exc:
        raise ExtractFailed(str(exc), classify_failure(str(exc))) from exc


def _audio(run: ExtractRun, source: ExtractSource, work: Path) -> Path:
    return source if isinstance(source, Path) else _fetch(run, source, work)


def _separate_missing(run: ExtractRun, source: Path, work: Path) -> Path:
    """Separate `source` into `work`; the folder holding every missing stem."""
    stems_root = separate(run.scratch, source, work)
    for name in run.stems:
        if not _wav(stems_root, name).is_file():
            raise ExtractFailed(f"the separator made no {name}", EXTRACT_FAILED_NO_OUTPUT)
    return stems_root


def _still_wanted(song: Job) -> bool:
    return registry_get(song.id) is song and song.trashed_at is None and song.status == STATUS_DONE


def _move_in(stems_root: Path, stems_dir: Path, names: list[str]) -> list[str]:
    """Move each absent stem of `names` in, into `placed` as it lands. A stem
    that turned up meanwhile is the song's own and is never replaced."""
    placed: list[str] = []
    try:
        for name in names:
            if stem_exists(stems_dir, name):
                continue
            os.replace(_wav(stems_root, name), _wav(stems_dir, name))
            placed.append(name)
    except Exception:
        _take_back(stems_dir, placed)
        raise
    return placed


def _take_back(stems_dir: Path, placed: list[str]) -> None:
    for name in placed:
        for ext in (WAV_EXT, MP3_EXT):
            (stems_dir / f"{name}{ext}").unlink(missing_ok=True)


def _read_peaks(stems_dir: Path) -> bytes | None:
    try:
        return (stems_dir / _PEAKS_FILE).read_bytes()
    except FileNotFoundError:
        return None


def _restore_peaks(stems_dir: Path, saved: bytes | None) -> None:
    path = stems_dir / _PEAKS_FILE
    if saved is None:
        path.unlink(missing_ok=True)
    else:
        path.write_bytes(saved)


def _presence_reference(song: Job, stems_dir: Path, placed: list[str]) -> str | None:
    """A stem the song already has presence for, to scale the new ones by."""
    known = song.stem_presence or {}
    return next(
        (n for n in known if n not in placed and stem_exists(stems_dir, n)),
        None,
    )


def _add_presence(song: Job, stems_dir: Path, placed: list[str]) -> None:
    """Peaks for the new stems, and their presence on the song's own scale."""
    reference = _presence_reference(song, stems_dir, placed)
    scanned = [reference, *placed] if reference else placed
    rms_values = merge_stem_peaks(stems_dir, scanned)
    if reference is None:
        return
    scaled = presence_for_split(rms_values, song.stem_presence, reference=reference)
    added = {n: v for n, v in scaled.items() if n in placed}
    if added:
        _set(song, stem_presence={**(song.stem_presence or {}), **added})


def _keep(
    song: Job,
    stems_dir: Path,
    stems_root: Path,
    run: ExtractRun,
    open_version: OpenVersion,
) -> None:
    """Move the stems in and open the version, all or nothing."""
    before = {
        "stems": song.stems,
        "stem_presence": song.stem_presence,
        "versions": song.versions,
        "open_version": song.open_version,
    }
    peaks = _read_peaks(stems_dir)
    placed = _move_in(stems_root, stems_dir, run.stems)
    try:
        _add_presence(song, stems_dir, placed)
        store_split_stems(song, stems_dir, placed, _never_cancelled)
        point_urls_at_disk(song, stems_dir, placed)
        run.version_id = open_version(song, run.wanted, run.name)
    except Exception:
        _set(song, **before)
        try:
            _take_back(stems_dir, placed)
        finally:
            _restore_peaks(stems_dir, peaks)
        raise


def extract_now(
    song: Job,
    stems_dir: Path,
    source: ExtractSource,
    run: ExtractRun,
    cancelled: Callable[[], bool],
    open_version: OpenVersion,
) -> None:
    """Separate the song's audio and keep its missing stems. Blocking. Raises
    JobCancelled once `cancelled()` turned true before the stems moved in."""
    work = stems_dir / f"{_TEMP_PREFIX}{uuid.uuid4().hex}{_TEMP_SUFFIX}"
    try:
        work.mkdir()
        audio = _audio(run, source, work)
        if cancelled():
            raise JobCancelled()
        run.phase = PHASE_SEPARATING
        _set(run.scratch, progress=0.0)
        stems_root = _separate_missing(run, audio, work)
        run.phase = PHASE_FINISHING
        with metadata_lock:
            if cancelled() or not _still_wanted(song):
                raise JobCancelled()
            _keep(song, stems_dir, stems_root, run, open_version)
        logger.info("[%s] extracted missing stems %s", song.id, ", ".join(run.stems))
        run.state = DONE
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _failure_code(exc: Exception) -> str:
    if isinstance(exc, ExtractFailed):
        return exc.code
    tail = getattr(exc, "tail", None) or []
    cause = classify_failure("\n".join([*tail, str(exc)]))
    return CAUSE_UNKNOWN if cause in _LINK_ONLY_CAUSES else cause


async def run_extract(
    song: Job,
    stems_dir: Path,
    source: ExtractSource,
    run: ExtractRun,
    open_version: OpenVersion,
) -> None:
    """A claimed extraction as a background run behind the pipeline lock."""

    def work(cancelled: Callable[[], bool]) -> None:
        try:
            extract_now(song, stems_dir, source, run, cancelled, open_version)
        except JobCancelled:
            raise
        except Exception as exc:
            if cancelled():
                raise JobCancelled() from exc
            run.error = _failure_code(exc)
            raise

    await run_behind_lock(song, run, work, "stem extraction")


def cancel_extract(song: Job) -> bool:
    """Ask a running extraction of `song` to stop. True when one was running.
    The scratch job is flagged first, so the separator reads the kill that
    follows as a cancel, never as a GPU failure to retry on the CPU."""
    run = EXTRACT_RUNS.current(song.id)
    if run is None or not EXTRACT_RUNS.running(song.id):
        return False
    run.scratch.cancel_requested = True
    return EXTRACT_RUNS.cancel(song.id)


def extract_view(song: Job) -> dict[str, Any]:
    """Where the song's latest extraction stands, for GET .../versions/extract:
    state IDLE when there is none since the server started."""
    run = EXTRACT_RUNS.current(song.id)
    if run is None:
        return {"state": IDLE}
    return {
        "state": run.state,
        "phase": run.phase,
        "progress": round(run.scratch.progress, _PROGRESS_DIGITS),
        "stems": run.stems,
        "error": run.error,
        "version_id": run.version_id,
    }
