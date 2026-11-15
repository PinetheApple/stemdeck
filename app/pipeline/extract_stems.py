"""Extracting the stems a finished song is missing (#175).

"Extract more stems" (POST /api/jobs/{id}/versions/extract) opens a version
showing more of the song's stems. When a stem file it needs is gone (removed
outside the app, a library rebuilt from a partial folder, a model with fewer
stems), the song's kept audio is separated again, and only the stems that are
absent are moved in: no file the song already has is ever replaced, so a song
open in the player keeps playing what it played.

A run of its own kind (runs.RunBoard, EXTRACT_RUNS), like the Lead + Backing
split: behind the pipeline lock, followed by GET .../versions/extract, stopped
by POST .../versions/extract/cancel, the Trash or a delete. The separator is
given a scratch Job with the song's id, never registered: it writes status,
progress and device on the job it is given, and the song stays "done" the
whole time. Nothing about a run is persisted, and nothing of the song changes
until it succeeds, so a failure, a cancel or a crash leaves the song as it was.
The separator writes into a dot temp folder in stems/, which the startup sweep
removes after a crash.
"""

from __future__ import annotations

import logging
import os
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar

from app.core.models import STATUS_DONE, Job, JobCancelled, _set
from app.core.registry import get as registry_get
from app.core.song_folder import metadata_lock
from app.core.stem_files import MP3_EXT, WAV_EXT, point_urls_at_disk, stem_exists
from app.pipeline.collect import merge_stem_peaks
from app.pipeline.errors import classify_failure
from app.pipeline.runs import CANCELLED, DONE, Run, RunBoard, run_behind_lock
from app.pipeline.separate import separate
from app.pipeline.stem_storage import store_split_stems

logger = logging.getLogger("stemdeck.pipeline")

# The phase of a running extraction: waiting for the pipeline lock, the
# separator, then moving the stems in.
PHASE_QUEUED = "queued"
PHASE_SEPARATING = "separating"
PHASE_FINISHING = "finishing"

# The separator ran but made no file for a stem: a model without that stem.
EXTRACT_FAILED_NO_OUTPUT = "no_output"

_TEMP_PREFIX = ".extract."
_TEMP_SUFFIX = ".tmp"
_PROGRESS_DIGITS = 3

# Records the version once the stems are in, under the metadata lock: the
# song, the stems it shows and its name, returning the id of the version opened.
OpenVersion = Callable[[Job, list[str], str], str]


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
    scratch: Job | None = None
    error: str | None = None
    version_id: str | None = None


EXTRACT_RUNS: RunBoard[ExtractRun] = RunBoard(ExtractRun)


def missing_stems(stems_dir: Path, wanted: list[str]) -> list[str]:
    return [name for name in wanted if not stem_exists(stems_dir, name)]


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


def _separate_missing(run: ExtractRun, source: Path, work: Path) -> Path:
    """Separate `source` into `work`; the folder holding every missing stem."""
    assert run.scratch is not None
    stems_root = separate(run.scratch, source, work)
    for name in run.stems:
        if not (stems_root / f"{name}{WAV_EXT}").is_file():
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
            os.replace(stems_root / f"{name}{WAV_EXT}", stems_dir / f"{name}{WAV_EXT}")
            placed.append(name)
    except Exception:
        _take_back(stems_dir, placed)
        raise
    return placed


def _take_back(stems_dir: Path, placed: list[str]) -> None:
    for name in placed:
        for ext in (WAV_EXT, MP3_EXT):
            (stems_dir / f"{name}{ext}").unlink(missing_ok=True)


def _keep(
    song: Job,
    stems_dir: Path,
    stems_root: Path,
    run: ExtractRun,
    open_version: OpenVersion,
) -> None:
    """Move the stems in and open the version, all or nothing."""
    before = {"stems": song.stems, "versions": song.versions, "open_version": song.open_version}
    placed = _move_in(stems_root, stems_dir, run.stems)
    try:
        merge_stem_peaks(stems_dir, placed)
        store_split_stems(song, stems_dir, placed, lambda: False)
        point_urls_at_disk(song, stems_dir, placed)
        run.version_id = open_version(song, run.wanted, run.name)
    except Exception:
        _take_back(stems_dir, placed)
        _set(song, **before)
        raise


def extract_now(
    song: Job,
    stems_dir: Path,
    source: Path,
    run: ExtractRun,
    cancelled: Callable[[], bool],
    open_version: OpenVersion,
) -> None:
    """Separate the song's audio and keep its missing stems. Blocking. Raises
    JobCancelled once `cancelled()` turned true before the stems moved in."""
    work = stems_dir / f"{_TEMP_PREFIX}{uuid.uuid4().hex}{_TEMP_SUFFIX}"
    try:
        work.mkdir()
        run.phase = PHASE_SEPARATING
        stems_root = _separate_missing(run, source, work)
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
    return classify_failure("\n".join([*tail, str(exc)]))


async def run_extract(
    song: Job,
    stems_dir: Path,
    source: Path,
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
    if run.scratch is not None:
        run.scratch.cancel_requested = True
    return EXTRACT_RUNS.cancel(song.id)


def extract_view(song: Job) -> dict[str, Any]:
    """Where the song's latest extraction stands, for GET .../versions/extract:
    {"state": "idle"} when there is none since the server started."""
    run = EXTRACT_RUNS.current(song.id)
    if run is None:
        return {"state": "idle"}
    progress = run.scratch.progress if run.scratch is not None else run.progress
    return {
        "state": run.state,
        "phase": run.phase,
        "progress": round(progress, _PROGRESS_DIGITS),
        "stems": run.stems,
        "error": run.error,
        "version_id": run.version_id,
    }
