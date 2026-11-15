"""Routes to record takes over a song and manage them (endpoints: docs/takes.md).

Placement is the server's alone: the client sends the song time at its first
captured frame, uncompensated, plus the round trip it measured; the render
bakes the placement into audio.wav, so no engine applies an offset and a
recalibration can re-place an old take.
"""

from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from app.api import takes_files
from app.api.stems import _title_slug
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
from app.core.song_folder import write_json_atomic
from app.core.takes import (
    is_finished,
    normalise_tracks,
    read_json,
    read_tracks,
    scan_takes,
    take_entry,
)
from app.core.takes_config import (
    LOGGER_NAME,
    PARTS_FILE,
    SIDECAR_FILE,
    TAKE_DOWNLOAD_FALLBACK,
    TAKE_MAX_PER_JOB,
    TAKE_MAX_SEQ,
    TAKE_PART_MAX_BYTES,
    TAKE_PEAKS_FILE,
    TAKE_SAMPLE_BYTES,
    TAKE_SLACK_SEC,
    TAKE_UNKNOWN_SONG_SEC,
    TAKE_WAV_FILE,
)

logger = logging.getLogger(LOGGER_NAME)

router = APIRouter()
router.include_router(tracks_router)

# A nudged take is rewritten under the same URL: revalidate every time.
_NO_CACHE = {"Cache-Control": "no-cache"}
_TIMING_FIELDS = ("round_trip_ms", "user_nudge_ms")


def _listing(job_id: str, job_dir: Path) -> dict[str, Any]:
    finished, open_ = scan_takes(job_dir, now=time.time())
    return {
        "tracks": normalise_tracks(read_tracks(job_dir), finished),
        "takes": [take_entry(job_id, s) for s in finished],
        "open": open_,
    }


@router.get("/{job_id}/takes")
async def list_takes(job_id: str) -> dict[str, Any]:
    _job, job_dir = ready_job(job_id)
    return await asyncio.to_thread(_listing, job_id, job_dir)


@router.post("/{job_id}/takes", status_code=201)
async def create_take(job_id: str, body: CreateTakeBody) -> dict[str, str]:
    refuse_while_moving()
    _job, job_dir = ready_job(job_id)
    async with job_lock(job_id):
        tracks = await asyncio.to_thread(read_tracks, job_dir)
        if not any(t["id"] == body.track_id for t in tracks):
            raise HTTPException(status_code=422, detail="unknown track")
        take_id, label = await asyncio.to_thread(
            takes_files.open_take,
            job_dir,
            body,
            TAKE_MAX_PER_JOB,
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
    capture = takes_files.capture_of(state)
    seconds = (job.duration_sec or TAKE_UNKNOWN_SONG_SEC) + TAKE_SLACK_SEC
    return int(seconds * capture["rate"] * capture["channels"] * TAKE_SAMPLE_BYTES)


def _append(job: Job, folder: Path, seq: int, data: bytes) -> dict[str, Any]:
    cap = _size_cap(job, takes_files.open_state(folder))
    return takes_files.append_part(folder, seq, data, cap)


@router.put("/{job_id}/takes/{take_id}/parts")
async def put_part(
    job_id: str,
    take_id: str,
    request: Request,
    seq: int = Query(..., ge=0, le=TAKE_MAX_SEQ),
) -> dict[str, Any]:
    refuse_while_moving()
    job, _job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    data = await _read_body_capped(request)
    if not data:
        raise HTTPException(status_code=422, detail="empty part")
    async with job_lock(job_id):
        result = await asyncio.to_thread(_append, job, folder, seq, data)
    return {"take_id": take_id, **result}


def _parts_view(folder: Path) -> dict[str, Any]:
    state = read_json(folder / PARTS_FILE)
    audio = state.get("audio") or {}
    return {
        "audio": {
            "next_seq": int(audio.get("next_seq") or 0),
            "bytes": int(audio.get("bytes") or 0),
        },
        "finished": bool(state.get("finished")) or is_finished(folder),
    }


@router.get("/{job_id}/takes/{take_id}/parts")
async def get_parts(job_id: str, take_id: str) -> dict[str, Any]:
    ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    return await asyncio.to_thread(_parts_view, folder)


def _activate(job_dir: Path, track_id: str, take_id: str) -> None:
    tracks = read_tracks(job_dir)
    for track in tracks:
        if track["id"] == track_id:
            track["active_take_id"] = take_id
    commit_tracks(job_dir, tracks)


def _finish(job_dir: Path, folder: Path, body: FinishBody) -> dict[str, Any]:
    state = takes_files.open_state(folder)
    if not any(t["id"] == state.get("track_id") for t in read_tracks(job_dir)):
        raise HTTPException(status_code=409, detail="track deleted")
    sidecar = takes_files.finish_take_files(job_dir, folder, body)
    _activate(job_dir, sidecar["track_id"], folder.name)
    return sidecar


@router.post("/{job_id}/takes/{take_id}/finish")
async def finish_take(job_id: str, take_id: str, body: FinishBody) -> dict[str, Any]:
    """Close the take and make it its track's active take."""
    refuse_while_moving()
    _job, job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    async with job_lock(job_id):
        sidecar = await asyncio.to_thread(_finish, job_dir, folder, body)
    logger.info("[%s] take %s finished at %.4f s", job_id, take_id, sidecar["placement_sec"])
    return take_entry(job_id, sidecar)


def _patch_files(job_dir: Path, folder: Path, body: PatchTakeBody) -> dict[str, Any]:
    if not is_finished(folder):
        raise HTTPException(status_code=409, detail="take not finished")
    sidecar = read_json(folder / SIDECAR_FILE)
    latency = sidecar.setdefault("latency", {})
    retime = False
    for name in _TIMING_FIELDS:
        value = getattr(body, name)
        if value is not None and value != latency.get(name):
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
    """Rename, or re-place: a timing change re-renders from the raw take."""
    refuse_while_moving()
    _job, job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    if not any(getattr(body, name) is not None for name in body.model_fields_set):
        raise HTTPException(status_code=422, detail="nothing to change")
    async with job_lock(job_id):
        sidecar = await asyncio.to_thread(_patch_files, job_dir, folder, body)
    return take_entry(job_id, sidecar)


def _delete_files(job_dir: Path, folder: Path) -> None:
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


def _finished_folder(job_id: str, take_id: str) -> tuple[Job, Path]:
    job, _job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    if not is_finished(folder):
        raise HTTPException(status_code=404, detail="take not finished")
    return job, folder


def _download_name(job: Job, folder: Path) -> str:
    label = read_json(folder / SIDECAR_FILE).get("label")
    parts = [p for p in (_title_slug(job.display_title), _title_slug(label)) if p]
    return f"{'_'.join(parts) or TAKE_DOWNLOAD_FALLBACK}{Path(TAKE_WAV_FILE).suffix}"


@router.api_route("/{job_id}/takes/{take_id}/audio.wav", methods=["GET", "HEAD"])
async def get_take_audio(job_id: str, take_id: str) -> FileResponse:
    job, folder = _finished_folder(job_id, take_id)
    return FileResponse(
        folder / TAKE_WAV_FILE,
        media_type="audio/wav",
        filename=_download_name(job, folder),
        headers=_NO_CACHE,
    )


@router.get("/{job_id}/takes/{take_id}/peaks")
async def get_take_peaks(job_id: str, take_id: str) -> FileResponse:
    _job, folder = _finished_folder(job_id, take_id)
    path = folder / TAKE_PEAKS_FILE
    if not path.is_file():
        raise HTTPException(status_code=404, detail="peaks not found")
    return FileResponse(path, media_type="application/json", headers=_NO_CACHE)
