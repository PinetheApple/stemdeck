"""Guards and the track-list commit shared by the takes and tracks routes."""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.core.config import JOB_ID_RE, JOBS_DIR
from app.core.models import STATUS_DONE, Job
from app.core.registry import get as registry_get
from app.core.stems_location import is_relocating
from app.core.takes import normalise_tracks, scan_takes, take_dir, write_tracks
from app.core.takes_config import TAKE_RELOCATING_RETRY_SEC

# One lock per song serialises every change to its takes and tracks: only one
# take records at a time, and a part is a few hundred KB.
_job_locks: dict[str, asyncio.Lock] = {}


def job_lock(job_id: str) -> asyncio.Lock:
    return _job_locks.setdefault(job_id, asyncio.Lock())


def known_job(job_id: str) -> tuple[Job, Path]:
    """The job and its folder, in any state, or 404."""
    job = registry_get(job_id) if JOB_ID_RE.match(job_id) else None
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job, JOBS_DIR / job_id


def ready_job(job_id: str) -> tuple[Job, Path]:
    """A finished song that is not in the Trash, and its folder, or 404:
    takes are recorded over stems, and a trashed song is on its way out."""
    job, folder = known_job(job_id)
    if job.status != STATUS_DONE or job.trashed_at is not None:
        raise HTTPException(status_code=404, detail="job not ready")
    return job, folder


def refuse_while_moving() -> None:
    """A write while the library moves would land in the folder being copied."""
    if is_relocating():
        raise HTTPException(
            status_code=503,
            detail="library is moving",
            headers={"Retry-After": str(TAKE_RELOCATING_RETRY_SEC)},
        )


def take_folder_or_404(job_id: str, take_id: str) -> Path:
    folder = take_dir(JOBS_DIR, job_id, take_id)
    if folder is None or not folder.is_dir():
        raise HTTPException(status_code=404, detail="take not found")
    return folder


def commit_tracks(job_dir: Path, tracks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalise the track list against the finished takes on disk and write
    it. Blocking: call it in a thread."""
    finished, _ = scan_takes(job_dir, now=time.time())
    normalised = normalise_tracks(tracks, finished)
    write_tracks(job_dir, normalised)
    return normalised
