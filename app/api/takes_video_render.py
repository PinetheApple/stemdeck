"""Routes to export a filmed take as MP4 (#102, #99): start a render, follow
it, cancel it, download the result. The client polls the status about
twice a second.

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
from app.api.takes_video_runs import RENDER_RUNS, RenderRun, run_key, start_render
from app.core.models import Job
from app.core.take_video_config import (
    RENDER_DOWNLOAD_SUFFIX,
    RENDER_FILE,
    RENDER_MEDIA_TYPE,
    RENDER_SIDECAR,
    STATUS_ERROR,
    STATUS_NONE,
    STATUS_QUEUED,
    STATUS_RUNNING,
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


def _url(job_id: str, folder: Path) -> str | None:
    if not (folder / RENDER_FILE).is_file():
        return None
    return f"/api/jobs/{job_id}/takes/{folder.name}/{RENDER_FILE}"


def _saved_view(job_id: str, folder: Path) -> dict[str, Any]:
    record = read_json(folder / RENDER_SIDECAR)
    url = _url(job_id, folder)
    if not record or url is None:
        return {"status": STATUS_NONE, "progress": 0.0, "url": None, "stale": False}
    sidecar = read_json(folder / SIDECAR_FILE)
    stale = inputs_sig(folder, sidecar, record.get("request") or {}) != record.get("inputs_sig")
    return {
        "status": DONE,
        "progress": 1.0,
        "url": url,
        **{name: record.get(name) for name in _ENCODER_FIELDS},
        "size": record.get("size"),
        "fps": record.get("fps"),
        "span": record.get("span"),
        "stale": stale,
    }


def _run_status(run: RenderRun) -> str:
    if run.state == RUNNING:
        return STATUS_RUNNING if run.started else STATUS_QUEUED
    return STATUS_ERROR if run.state == FAILED else run.state


def _live_view(job_id: str, folder: Path, run: RenderRun) -> dict[str, Any]:
    plan = run.planned.plan
    return {
        **dict.fromkeys(_ENCODER_FIELDS),
        "status": _run_status(run),
        "progress": run.progress,
        "error": run.error,
        "url": _url(job_id, folder),
        "size": run.planned.request["size"],
        "fps": plan.fps,
        "span": {"start_sec": plan.start_sec, "duration_sec": plan.duration_sec},
        "stale": False,
    }


def render_view(job_id: str, folder: Path) -> dict[str, Any]:
    run = RENDER_RUNS.current(run_key(job_id, folder.name))
    if run is not None and run.state != DONE and run.planned is not None:
        return _live_view(job_id, folder, run)
    view = {"error": None, **dict.fromkeys(_ENCODER_FIELDS), "size": None, "fps": None}
    return {**view, "span": None, **_saved_view(job_id, folder)}


@router.post("/{job_id}/takes/{take_id}/render", status_code=202)
async def post_render(job_id: str, take_id: str, body: RenderBody) -> dict[str, Any]:
    job, folder = _finished_folder(job_id, take_id)
    if not await asyncio.to_thread(render_tools_available):
        raise HTTPException(status_code=503, detail="this ffmpeg cannot make MP4 video")
    if RENDER_RUNS.running(run_key(job_id, take_id)):
        raise HTTPException(status_code=409, detail="a render of this take is running")
    planned = await asyncio.to_thread(plan_render, job_id, folder.parent.parent, folder, body)
    if start_render(job, folder, planned) is None:
        raise HTTPException(status_code=409, detail="a render of this take is running")
    return render_view(job_id, folder)


@router.get("/{job_id}/takes/{take_id}/render")
async def get_render(job_id: str, take_id: str) -> dict[str, Any]:
    _job, folder = _finished_folder(job_id, take_id)
    return await asyncio.to_thread(render_view, job_id, folder)


@router.post("/{job_id}/takes/{take_id}/render/cancel")
async def cancel_render(job_id: str, take_id: str) -> dict[str, Any]:
    _job, folder = _finished_folder(job_id, take_id)
    RENDER_RUNS.cancel(run_key(job_id, take_id))
    return render_view(job_id, folder)


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
