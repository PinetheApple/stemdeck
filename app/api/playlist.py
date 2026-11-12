"""Playlist import: expand a playlist URL into one queued job per track.

Two steps on purpose. Expansion is a network round trip whose result the user
has to agree to -- "this is 47 tracks, still want it?" -- and a single endpoint
would either queue 47 jobs with no warning or make the client re-post a list of
URLs it was handed. The client never supplies the track list: preview and
create both expand server-side, so nothing outside the SSRF allowlist can be
smuggled into the pipeline between the two calls.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.api.jobs import job_files_missing
from app.core.config import JOBS_DIR, MAX_PENDING_URL_JOBS, STEM_NAMES
from app.core.models import FINISHED_STATUSES, STATUS_DONE, Job
from app.core.registry import all_jobs as registry_all_jobs
from app.core.registry import pending_count as registry_pending_count
from app.core.registry import persist as registry_persist
from app.core.registry import register_if_capacity as registry_register_if_capacity
from app.core.settings import get_auto_sections, get_max_duration_sec, get_playlist_max_items
from app.core.stems_location import is_relocating
from app.pipeline import jobqueue
from app.pipeline.download import InvalidPlaylistURL, expand_playlist

logger = logging.getLogger("stemdeck.api")

router = APIRouter(tags=["playlist"])

SKIP_IN_LIBRARY = "in_library"
SKIP_TOO_LONG = "too_long"
SKIP_NO_CAPACITY = "no_capacity"
# A copy in any of these states no longer holds the song, so importing it again is wanted.
_GONE_STATUSES = FINISHED_STATUSES - {STATUS_DONE}

Track = dict[str, Any]


class PlaylistRequest(BaseModel):
    url: str
    stems: list[str] | None = None


def _capacity_left() -> int:
    # Playlist tracks are links, so only other waiting links count against
    # them -- a backlog of file uploads is bounded separately and holds disk
    # rather than a registry record.
    return max(0, MAX_PENDING_URL_JOBS - registry_pending_count(uploads=False))


async def _expand(url: str) -> dict[str, Any]:
    """yt-dlp is blocking and a large playlist takes seconds. Off the event loop
    it goes, or every SSE stream (including the running job's progress) stalls
    for the duration."""
    try:
        return await asyncio.to_thread(expand_playlist, url, get_playlist_max_items())
    except InvalidPlaylistURL as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception as e:
        logger.exception("playlist expansion failed")
        raise HTTPException(status_code=502, detail="Could not read that playlist") from e


def _partition(items: list[Track]) -> tuple[list[Track], list[Track]]:
    """Split out tracks that are longer than the configured limit. They would be
    accepted here and then fail one by one in the pipeline, so the dialog is a
    better place to say so."""
    max_duration = get_max_duration_sec()
    cap = get_playlist_max_items()
    keep, too_long = [], []
    for item in items:
        if _too_long(item.get("duration"), max_duration):
            too_long.append(item)
            continue
        keep.append(item)
    return keep[:cap], too_long


def _holds_song(job: Job) -> bool:
    if not job.source_url or job.trashed_at is not None or job.status in _GONE_STATUSES:
        return False
    return job.status != STATUS_DONE or not job_files_missing(job)


def _gone_copies() -> dict[str, str]:
    """Source URL to the done job whose files are gone, for a new import to replace."""
    return {
        job.source_url: job.id
        for job in registry_all_jobs().values()
        if job.source_url
        and job.trashed_at is None
        and job.status == STATUS_DONE
        and job_files_missing(job)
    }


def _too_long(duration: object, limit: int) -> bool:
    return isinstance(duration, int | float) and duration > limit


def _library_jobs() -> dict[str, str]:
    return {job.source_url: job.id for job in registry_all_jobs().values() if _holds_song(job)}


def _library_urls() -> set[str]:
    return set(_library_jobs())


def _split_in_library(items: list[Track]) -> tuple[list[Track], list[Track]]:
    """Tracks the library has no live copy of, and those it has. A track listed
    twice in the playlist counts as in the library from its second listing."""
    known = _library_urls()
    missing, present = [], []
    for item in items:
        (present if item["url"] in known else missing).append(item)
        known.add(item["url"])
    return missing, present


def _skipped(items: list[Track], reason: str) -> list[dict[str, str]]:
    return [{"title": i["title"] or "", "source_url": i["url"], "reason": reason} for i in items]


@router.post("/preview")
async def preview_playlist(request: Request) -> dict[str, Any]:
    """Expand a playlist and report what importing it would do. Creates nothing."""
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid JSON: {e}") from e
    try:
        payload = PlaylistRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    result = await _expand(payload.url)
    items, too_long = _partition(result["items"])
    items, in_library = _split_in_library(items)
    capacity = _capacity_left()

    return {
        "playlist_title": result["playlist_title"],
        "total_found": len(result["items"]) + result["unavailable"],
        "will_queue": min(len(items), capacity),
        "skipped_unavailable": result["unavailable"],
        "skipped_too_long": len(too_long),
        "skipped_in_library": len(in_library),
        "capacity_left": capacity,
        "cap": get_playlist_max_items(),
        # The playlist has more tracks than the cap allows us to look at, so
        # total_found is a floor, not the real total.
        "truncated": result["truncated"],
        "items": [{"title": i["title"], "duration": i["duration"]} for i in items],
    }


@router.post("")
async def create_playlist_jobs(request: Request) -> dict[str, Any]:
    """Queue one job per playlist track, in playlist order.

    Fills whatever capacity is available rather than failing the whole import:
    the preview already told the user how many would be queued, and a partial
    fill with an honest count beats a 503 after they agreed to it. Tracks the
    library already holds are left out, so importing a playlist again tops it
    up. Every track left out is listed in ``skipped`` with its reason.
    """
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid JSON: {e}") from e
    try:
        payload = PlaylistRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    if is_relocating():
        raise HTTPException(
            status_code=409,
            detail="Restart StemDeck to finish moving your stems folder before importing",
        )

    selected = [s for s in payload.stems if s in STEM_NAMES] if payload.stems else list(STEM_NAMES)
    if not selected:
        selected = list(STEM_NAMES)

    result = await _expand(payload.url)
    items, too_long = _partition(result["items"])
    if not items:
        raise HTTPException(status_code=422, detail="No importable tracks in that playlist")
    items, in_library = _split_in_library(items)
    if items and _capacity_left() == 0:
        raise HTTPException(status_code=503, detail="Queue is full - wait or cancel a job")

    # Read once for the batch, so every job in one playlist import agrees, and
    # captured now rather than when each job reaches its sections stage.
    auto_sections = get_auto_sections()
    created: list[dict[str, Any]] = []
    left_out: list[Track] = []
    gone = _gone_copies()
    for item in items:
        job = Job(
            id=uuid.uuid4().hex[:12],
            selected_stems=list(selected),
            source_url=item["url"],
            # Pre-filled from the flat metadata so queue rows carry real names
            # immediately, instead of a URL until each download starts.
            title=item["title"] or None,
            thumbnail=item.get("thumbnail"),
            auto_sections=auto_sections,
            replaces=gone.get(item["url"]),
        )
        if not registry_register_if_capacity(job, MAX_PENDING_URL_JOBS):
            left_out = items[len(created) :]
            break
        jobqueue.enqueue(job.id)
        created.append(
            {
                "job_id": job.id,
                "title": job.title or "",
                "source_url": item["url"],
                "replaces": job.replaces,
            }
        )

    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return {
        "playlist_title": result["playlist_title"],
        "jobs": created,
        "queued": len(created),
        "skipped_unavailable": result["unavailable"],
        "skipped_too_long": len(too_long),
        "skipped_in_library": len(in_library),
        "skipped_no_capacity": len(left_out),
        "skipped": [
            *_skipped(in_library, SKIP_IN_LIBRARY),
            *_skipped(too_long, SKIP_TOO_LONG),
            *_skipped(left_out, SKIP_NO_CAPACITY),
        ],
    }
