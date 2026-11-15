"""Recorded takes (#98): record yourself over a song. Contract: docs/takes.md.

    GET    /api/jobs/{id}/takes                              tracks, finished and open takes
    POST   /api/jobs/{id}/takes                              open a take, 201
    PUT    /api/jobs/{id}/takes/{take_id}/parts/audio?seq=n  raw float32 PCM, in order
    GET    /api/jobs/{id}/takes/{take_id}/parts              upload state, to resume
    POST   /api/jobs/{id}/takes/{take_id}/finish             render the lane, list the take
    PATCH  /api/jobs/{id}/takes/{take_id}                    label, round trip, nudge
    DELETE /api/jobs/{id}/takes/{take_id}
    GET    /api/jobs/{id}/takes/{take_id}/audio.wav          (and HEAD), Range
    GET    /api/jobs/{id}/takes/{take_id}/peaks

plus the track routes in app/api/takes_tracks.py, included here.

Placement is the server's alone: the client sends the song time at its first
captured frame, uncompensated, and the round trip it measured (or estimated);
app.core.takes.placement_sec subtracts both and the user's nudge, and the
render bakes the result into audio.wav. Playback and every export read that
file, so no engine applies an offset, and a recalibration can re-place an old
take with a PATCH.

After upstream 900234d (app/api/takes.py); the fork keeps takes as files
only, out of the job record and out of stems/peaks.json, which the bundle ships.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from app.api import takes_files
from app.api.takes_common import (
    commit_tracks,
    job_lock,
    known_job,
    ready_job,
    refuse_while_moving,
    take_folder_or_404,
)
from app.api.takes_models import CreateTakeBody, FinishBody, PatchTakeBody
from app.api.takes_tracks import router as tracks_router
from app.core.models import Job
from app.core.takes import (
    is_finished,
    normalise_tracks,
    read_json,
    read_tracks,
    scan_takes,
    take_entry,
    write_json_atomic,
)
from app.core.takes_config import (
    PARTS_FILE,
    SIDECAR_FILE,
    TAKE_MAX_PER_JOB,
    TAKE_MAX_SEQ,
    TAKE_PART_MAX_BYTES,
    TAKE_PEAKS_FILE,
    TAKE_SAMPLE_BYTES,
    TAKE_SLACK_SEC,
    TAKE_UNKNOWN_SONG_SEC,
    TAKE_WAV_FILE,
)

logger = logging.getLogger("stemdeck.takes")

router = APIRouter()
router.include_router(tracks_router)

_AUDIO_KIND = "audio"
# A nudged take is rewritten under the same URL: revalidate every time.
_NO_CACHE = {"Cache-Control": "no-cache"}


def _listing(job_id: str, job_dir) -> dict[str, Any]:
    finished, open_ = scan_takes(job_dir, now=time.time())
    tracks = normalise_tracks(read_tracks(job_dir), finished)
    return {
        "tracks": tracks,
        "takes": [take_entry(job_id, s) for s in finished],
        "open": open_,
    }


@router.get("/{job_id}/takes")
async def list_takes(job_id: str) -> dict[str, Any]:
    _job, job_dir = ready_job(job_id)
    return await asyncio.to_thread(_listing, job_id, job_dir)


@router.post("/{job_id}/takes", status_code=201)
async def create_take(job_id: str, body: CreateTakeBody) -> dict[str, str]:
    """Open a take on a track, with the start sidecar the recorder knows once
    its first frame is captured."""
    refuse_while_moving()
    _job, job_dir = ready_job(job_id)
    async with job_lock(job_id):
        tracks = await asyncio.to_thread(read_tracks, job_dir)
        if not any(t["id"] == body.track_id for t in tracks):
            raise HTTPException(status_code=422, detail="unknown track")
        take_id, label = await asyncio.to_thread(
            takes_files.open_take, job_dir, body, TAKE_MAX_PER_JOB
        )
    logger.info("[%s] take %s opened on track %s", job_id, take_id, body.track_id)
    return {"take_id": take_id, "label": label, "track_id": body.track_id}


async def _read_body_capped(request: Request) -> bytes:
    """The raw body, refused past TAKE_PART_MAX_BYTES while it streams in:
    the declared length can be absent or wrong."""
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > TAKE_PART_MAX_BYTES:
            raise HTTPException(status_code=413, detail="part too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _size_cap(job: Job, state: dict[str, Any]) -> int:
    """The song's length plus slack, at the take's own capture format."""
    capture = state["start"]["capture"]
    seconds = (job.duration_sec or TAKE_UNKNOWN_SONG_SEC) + TAKE_SLACK_SEC
    return int(seconds * capture["rate"] * capture["channels"] * TAKE_SAMPLE_BYTES)


@router.put("/{job_id}/takes/{take_id}/parts/{kind}")
async def put_part(
    job_id: str,
    take_id: str,
    kind: str,
    request: Request,
    seq: int = Query(..., ge=0, le=TAKE_MAX_SEQ),
) -> dict[str, Any]:
    refuse_while_moving()
    job, _job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    if kind != _AUDIO_KIND:
        raise HTTPException(status_code=404, detail="unknown part kind")
    data = await _read_body_capped(request)
    if not data:
        raise HTTPException(status_code=422, detail="empty part")
    async with job_lock(job_id):
        state = await asyncio.to_thread(read_json, folder / PARTS_FILE)
        if not state:
            raise HTTPException(status_code=404, detail="take not found")
        cap = _size_cap(job, state)
        result = await asyncio.to_thread(takes_files.append_part, folder, seq, data, cap)
    return {"take_id": take_id, "kind": kind, **result}


@router.get("/{job_id}/takes/{take_id}/parts")
async def get_parts(job_id: str, take_id: str) -> dict[str, Any]:
    ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    state = await asyncio.to_thread(read_json, folder / PARTS_FILE)
    audio = state.get(_AUDIO_KIND) or {}
    return {
        _AUDIO_KIND: {
            "next_seq": int(audio.get("next_seq") or 0),
            "bytes": int(audio.get("bytes") or 0),
        },
        "finished": bool(state.get("finished")),
    }


def _activate(job_dir, track_id: str, take_id: str) -> None:
    tracks = read_tracks(job_dir)
    for track in tracks:
        if track["id"] == track_id:
            track["active_take_id"] = take_id
    commit_tracks(job_dir, tracks)


@router.post("/{job_id}/takes/{take_id}/finish")
async def finish_take(job_id: str, take_id: str, body: FinishBody) -> dict[str, Any]:
    """Close the take and make it its track's active take. Synchronous: a
    five-minute take renders in a second or two."""
    refuse_while_moving()
    _job, job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    async with job_lock(job_id):
        state = await asyncio.to_thread(read_json, folder / PARTS_FILE)
        tracks = await asyncio.to_thread(read_tracks, job_dir)
        if not state.get("finished") and not any(t["id"] == state.get("track_id") for t in tracks):
            raise HTTPException(status_code=409, detail="track deleted")
        sidecar = await asyncio.to_thread(takes_files.finish_take_files, job_dir, folder, body)
        await asyncio.to_thread(_activate, job_dir, sidecar["track_id"], take_id)
    logger.info("[%s] take %s finished at %.4f s", job_id, take_id, sidecar["placement_sec"])
    return take_entry(job_id, sidecar)


def _patch_files(job_dir, folder, body: PatchTakeBody) -> dict[str, Any]:
    sidecar = read_json(folder / SIDECAR_FILE)
    latency = sidecar.setdefault("latency", {})
    fields = body.model_fields_set
    retime = False
    for name in ("round_trip_ms", "user_nudge_ms"):
        value = getattr(body, name)
        if name in fields and value is not None and value != latency.get(name):
            latency[name] = value
            retime = True
    if body.label is not None:
        sidecar["label"] = body.label
    if retime:
        takes_files.render_lane(job_dir, folder, sidecar)
    write_json_atomic(folder / SIDECAR_FILE, sidecar)
    return sidecar


@router.patch("/{job_id}/takes/{take_id}")
async def patch_take(job_id: str, take_id: str, body: PatchTakeBody) -> dict[str, Any]:
    """Rename, or re-place (re-renders audio.wav and peaks from the raw take)."""
    refuse_while_moving()
    _job, job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    if not any(getattr(body, name) is not None for name in body.model_fields_set):
        raise HTTPException(status_code=422, detail="nothing to change")
    async with job_lock(job_id):
        if not await asyncio.to_thread(is_finished, folder):
            raise HTTPException(status_code=409, detail="take not finished")
        sidecar = await asyncio.to_thread(_patch_files, job_dir, folder, body)
    return take_entry(job_id, sidecar)


def _delete_files(job_dir, folder) -> None:
    takes_files.remove_take(folder)
    commit_tracks(job_dir, read_tracks(job_dir))


@router.delete("/{job_id}/takes/{take_id}")
async def delete_take(job_id: str, take_id: str) -> dict[str, str]:
    """Remove a take, open or finished; its track falls back to its newest
    remaining take."""
    refuse_while_moving()
    _job, job_dir = known_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    async with job_lock(job_id):
        await asyncio.to_thread(_delete_files, job_dir, folder)
    logger.info("[%s] take %s deleted", job_id, take_id)
    return {"take_id": take_id, "status": "deleted"}


def _finished_file(job_id: str, take_id: str, name: str):
    ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    if not is_finished(folder):
        raise HTTPException(status_code=404, detail="take not finished")
    return folder / name


@router.api_route("/{job_id}/takes/{take_id}/audio.wav", methods=["GET", "HEAD"])
async def get_take_audio(job_id: str, take_id: str) -> FileResponse:
    path = _finished_file(job_id, take_id, TAKE_WAV_FILE)
    return FileResponse(path, media_type="audio/wav", headers=_NO_CACHE)


@router.get("/{job_id}/takes/{take_id}/peaks")
async def get_take_peaks(job_id: str, take_id: str) -> FileResponse:
    path = _finished_file(job_id, take_id, TAKE_PEAKS_FILE)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="peaks not found")
    return FileResponse(path, media_type="application/json", headers=_NO_CACHE)
