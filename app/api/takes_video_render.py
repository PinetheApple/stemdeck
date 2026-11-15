"""Routes to export a filmed take as MP4: start a render, follow it, cancel
it, download the result. The client polls the status about twice a second.

While a render is queued, running, failed or cancelled, its status comes
from memory; otherwise from render.json, which names the encoder that made
render.mp4. `stale` says the take or the request changed since.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.api.stems import _title_slug
from app.api.takes_common import ready_job, take_folder_or_404
from app.api.takes_video_models import RenderBody
from app.api.takes_video_plan import inputs_sig, plan_render
from app.api.takes_video_runs import (
    RENDER_RUNS,
    RenderRun,
    file_identity,
    run_key,
    span_of,
    start_render,
    sweep_once,
)
from app.core.config import JOBS_DIR
from app.core.models import Job
from app.core.take_video_config import (
    RENDER_BUSY_DETAIL,
    RENDER_DOWNLOAD_SUFFIX,
    RENDER_FILE,
    RENDER_MEDIA_TYPE,
    RENDER_SIDECAR,
    STATUS_ERROR,
    STATUS_NONE,
    STATUS_QUEUED,
)
from app.core.takes import is_finished, read_json
from app.core.takes_config import SIDECAR_FILE, TAKE_DOWNLOAD_FALLBACK
from app.pipeline.runs import DONE, FAILED, RUNNING
from app.pipeline.take_video_tools import render_tools_available

router = APIRouter()

_NO_CACHE = {"Cache-Control": "no-cache"}
_ENCODER_FIELDS = ("encoder", "family", "fallback_reason", "made_at")


def _finished_folder(job_id: str, take_id: str) -> tuple[Job, Path]:
    job, _job_dir = ready_job(job_id)
    folder = take_folder_or_404(job_id, take_id)
    if not is_finished(folder):
        raise HTTPException(status_code=404, detail="take not finished")
    return job, folder


def _run_status(run: RenderRun) -> str:
    if run.state == RUNNING:
        return RUNNING if run.started else STATUS_QUEUED
    return STATUS_ERROR if run.state == FAILED else run.state


def _describes(record: dict[str, Any], path: Path) -> bool:
    """Whether render.json names the render.mp4 on disk: a crash between
    writing one and replacing the other leaves them apart."""
    return path.is_file() and record.get("file") == file_identity(path)


def _stale(folder: Path, record: dict[str, Any]) -> bool:
    sidecar = read_json(folder / SIDECAR_FILE)
    return inputs_sig(folder, sidecar, record.get("request") or {}) != record.get("inputs_sig")


def render_view(job_id: str, folder: Path) -> dict[str, Any]:
    """The render status: the run in memory unless it finished, else what
    render.json says about the render.mp4 it names, else none."""
    run = RENDER_RUNS.current(run_key(job_id, folder.name))
    path = folder / RENDER_FILE
    record: dict[str, Any] = {}
    if run is not None and run.state != DONE and run.planned is not None:
        request, plan = run.planned.request, run.planned.plan
        state = (_run_status(run), run.progress, run.error, span_of(plan), False)
        settings = {"size": request["size"], "fps": plan.fps}
    elif path.is_file() and (record := read_json(folder / RENDER_SIDECAR)):
        # A record of another file says nothing true about this one.
        record = record if _describes(record, path) else {}
        state = (DONE, 1.0, None, record.get("span"), not record or _stale(folder, record))
        settings = {"size": record.get("size"), "fps": record.get("fps")}
    else:
        state = (STATUS_NONE, 0.0, None, None, False)
        settings = {"size": None, "fps": None}
    status, progress, error, span, stale = state
    url = f"/api/jobs/{job_id}/takes/{folder.name}/{RENDER_FILE}" if path.is_file() else None
    return {
        "status": status,
        "progress": progress,
        "error": error,
        "url": url,
        **{name: record.get(name) for name in _ENCODER_FIELDS},
        **settings,
        "span": span,
        "stale": stale,
    }


def _view_after_sweep(job_id: str, folder: Path) -> dict[str, Any]:
    sweep_once(JOBS_DIR)
    return render_view(job_id, folder)


@router.post("/{job_id}/takes/{take_id}/render", status_code=202)
async def post_render(job_id: str, take_id: str, body: RenderBody) -> dict[str, Any]:
    job, folder = _finished_folder(job_id, take_id)
    if not await asyncio.to_thread(render_tools_available):
        raise HTTPException(status_code=503, detail="this ffmpeg cannot make MP4 video")
    planned = await asyncio.to_thread(plan_render, job_id, folder.parent.parent, folder, body)
    if start_render(job, folder, planned) is None:
        raise HTTPException(status_code=409, detail=RENDER_BUSY_DETAIL)
    return await asyncio.to_thread(_view_after_sweep, job_id, folder)


@router.get("/{job_id}/takes/{take_id}/render")
async def get_render(job_id: str, take_id: str) -> dict[str, Any]:
    _job, folder = _finished_folder(job_id, take_id)
    return await asyncio.to_thread(_view_after_sweep, job_id, folder)


@router.post("/{job_id}/takes/{take_id}/render/cancel")
async def cancel_render(job_id: str, take_id: str) -> dict[str, Any]:
    _job, folder = _finished_folder(job_id, take_id)
    RENDER_RUNS.cancel(run_key(job_id, take_id))
    return await asyncio.to_thread(render_view, job_id, folder)


@router.api_route(f"/{{job_id}}/takes/{{take_id}}/{RENDER_FILE}", methods=["GET", "HEAD"])
async def get_render_file(job_id: str, take_id: str) -> FileResponse:
    job, folder = _finished_folder(job_id, take_id)
    path = folder / RENDER_FILE
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no export yet")
    label = read_json(folder / SIDECAR_FILE).get("label")
    parts = [p for p in (_title_slug(job.display_title), _title_slug(label)) if p]
    name = f"{'_'.join(parts) or TAKE_DOWNLOAD_FALLBACK}{RENDER_DOWNLOAD_SUFFIX}"
    return FileResponse(path, media_type=RENDER_MEDIA_TYPE, filename=name, headers=_NO_CACHE)
