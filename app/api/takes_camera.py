"""Routes for a filmed take's camera: its MediaRecorder chunks while the take
records, and the finished camera file for review.

Chunks follow the audio parts' rules: the next seq only, the last one
repeated is a no-op, and a crash never leaves a part in twice.
"""

from __future__ import annotations

import asyncio
import mimetypes
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse

from app.api import takes_files
from app.api.takes_camera_files import CAMERA_STREAM
from app.api.takes_common import (
    job_lock,
    read_body_capped,
    ready_job,
    refuse_while_moving,
    take_folder_or_404,
)
from app.core.models import Job
from app.core.take_video import camera_file
from app.core.take_video_config import CAMERA_PART_FILE, TAKE_CAMERA_MAX_BYTES_PER_SEC
from app.core.takes import is_finished
from app.core.takes_config import TAKE_MAX_SEQ, TAKE_SLACK_SEC, TAKE_UNKNOWN_SONG_SEC

router = APIRouter()

_NO_CACHE = {"Cache-Control": "no-cache"}


def camera_cap(job: Job) -> int:
    """The song's length plus slack, at the recorder's rate with room."""
    seconds = (job.duration_sec or TAKE_UNKNOWN_SONG_SEC) + TAKE_SLACK_SEC
    return int(seconds * TAKE_CAMERA_MAX_BYTES_PER_SEC)


def _append_camera(job: Job, folder: Path, seq: int, data: bytes) -> dict[str, Any]:
    state = takes_files.open_state(folder)
    if not isinstance(state.get(CAMERA_STREAM), dict):
        raise HTTPException(status_code=404, detail="take not opened with a camera")
    return takes_files.append_stream(
        folder,
        state,
        CAMERA_STREAM,
        CAMERA_PART_FILE,
        seq,
        data,
        camera_cap(job),
    )


@router.put("/{job_id}/takes/{take_id}/camera/parts")
async def put_camera_part(
    job_id: str,
    take_id: str,
    request: Request,
    seq: int = Query(..., ge=0, le=TAKE_MAX_SEQ),
) -> dict[str, Any]:
    refuse_while_moving()
    job, _job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    data = await read_body_capped(request)
    if not data:
        raise HTTPException(status_code=422, detail="empty part")
    async with job_lock(job_id):
        result = await asyncio.to_thread(_append_camera, job, folder, seq, data)
    return {"take_id": take_id, **result}


@router.api_route("/{job_id}/takes/{take_id}/camera", methods=["GET", "HEAD"])
async def get_camera(job_id: str, take_id: str) -> FileResponse:
    """The camera file as the browser recorded it, with Range support."""
    ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    path = camera_file(folder) if is_finished(folder) else None
    if path is None:
        raise HTTPException(status_code=404, detail="take has no camera")
    media_type = mimetypes.guess_type(path.name)[0]
    return FileResponse(path, media_type=media_type, headers=_NO_CACHE)
