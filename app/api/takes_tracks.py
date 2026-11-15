"""Routes for recording tracks: a track is one mixer lane that owns takes and
plays its active one."""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

from app.api.takes_common import commit_tracks, job_lock, known_job, ready_job, refuse_while_moving
from app.api.takes_files import remove_take
from app.api.takes_models import CreateTrackBody, PatchTrackBody
from app.core.takes import make_track, new_id, read_tracks, scan_takes, takes_on_track
from app.core.takes_config import (
    LOGGER_NAME,
    TAKES_DIRNAME,
    TRACK_ID_PREFIX,
    TRACK_MAX_PER_JOB,
    TRACK_NAME_TEMPLATE,
)

logger = logging.getLogger(LOGGER_NAME)

router = APIRouter()


def _track_or_404(tracks: list[dict[str, Any]], track_id: str) -> dict[str, Any]:
    track = next((t for t in tracks if t["id"] == track_id), None)
    if track is None:
        raise HTTPException(status_code=404, detail="track not found")
    return track


def _default_name(tracks: list[dict[str, Any]]) -> str:
    names = {t.get("name") for t in tracks}
    n = len(tracks) + 1
    while TRACK_NAME_TEMPLATE.format(n=n) in names:
        n += 1
    return TRACK_NAME_TEMPLATE.format(n=n)


def _add_track(job_dir: Path, body: CreateTrackBody, track_max: int) -> dict[str, Any]:
    tracks = read_tracks(job_dir)
    if len(tracks) >= track_max:
        raise HTTPException(status_code=409, detail="too many tracks for this song")
    track = make_track(
        new_id(TRACK_ID_PREFIX, {t["id"] for t in tracks}),
        body.name or _default_name(tracks),
        len(tracks),
        body.input.model_dump() if body.input else None,
    )
    saved = commit_tracks(job_dir, [*tracks, track])
    return _track_or_404(saved, track["id"])


@router.post("/{job_id}/tracks", status_code=201)
async def create_track(job_id: str, body: CreateTrackBody) -> dict[str, Any]:
    refuse_while_moving()
    _job, job_dir = ready_job(job_id)
    async with job_lock(job_id):
        track = await asyncio.to_thread(
            _add_track,
            job_dir,
            body,
            TRACK_MAX_PER_JOB,
        )
    logger.info("[%s] track %s created", job_id, track["id"])
    return track


def _check_active(job_dir: Path, track_id: str, take_id: str | None) -> str:
    finished, _ = scan_takes(job_dir, now=time.time())
    if take_id is None or not any(
        s["id"] == take_id and s.get("track_id") == track_id for s in finished
    ):
        raise HTTPException(status_code=422, detail="not a finished take of this track")
    return take_id


def _apply_patch(job_dir: Path, track_id: str, body: PatchTrackBody) -> dict[str, Any]:
    tracks = read_tracks(job_dir)
    track = dict(_track_or_404(tracks, track_id))
    fields = body.model_fields_set
    if "name" in fields:
        if body.name is None:
            raise HTTPException(status_code=422, detail="name cannot be empty")
        track["name"] = body.name
    if "input" in fields:
        track["input"] = body.input.model_dump() if body.input else None
    if "active_take_id" in fields:
        track["active_take_id"] = _check_active(job_dir, track_id, body.active_take_id)
    others = [t for t in tracks if t["id"] != track_id]
    position = track["order"] if body.order is None else min(body.order, len(others))
    others.insert(position, track)
    for i, t in enumerate(others):
        t["order"] = i
    return _track_or_404(commit_tracks(job_dir, others), track_id)


@router.patch("/{job_id}/tracks/{track_id}")
async def patch_track(job_id: str, track_id: str, body: PatchTrackBody) -> dict[str, Any]:
    """Rename, set the input (null clears it), switch the active take, or move
    the track to another position."""
    refuse_while_moving()
    _job, job_dir = ready_job(job_id)
    if not body.model_fields_set:
        raise HTTPException(status_code=422, detail="nothing to change")
    async with job_lock(job_id):
        return await asyncio.to_thread(_apply_patch, job_dir, track_id, body)


def _remove_track(job_dir: Path, track_id: str) -> list[str]:
    tracks = read_tracks(job_dir)
    _track_or_404(tracks, track_id)
    # The track goes first, so a take cut off below can never come back active.
    commit_tracks(job_dir, [t for t in tracks if t["id"] != track_id])
    owned = takes_on_track(job_dir / TAKES_DIRNAME, track_id)
    for folder in owned:
        remove_take(folder)
    commit_tracks(job_dir, read_tracks(job_dir))
    return [p.name for p in owned]


@router.delete("/{job_id}/tracks/{track_id}")
async def delete_track(job_id: str, track_id: str) -> dict[str, Any]:
    refuse_while_moving()
    _job, job_dir = known_job(job_id)
    async with job_lock(job_id):
        removed = await asyncio.to_thread(_remove_track, job_dir, track_id)
    logger.info("[%s] track %s deleted with %d takes", job_id, track_id, len(removed))
    return {"track_id": track_id, "status": "deleted", "takes_deleted": removed}
