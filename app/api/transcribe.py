"""Lyrics transcribed on demand, for a track that has none (the Lyrics tab's
"Transcribe lyrics", app/pipeline/transcribe_on_demand.py).

Follows POST/GET .../lyrics/retime (app/api/jobs.py): POST starts a run in
the background, behind the pipeline lock, and answers 202; GET follows it;
the job's own POST .../cancel stops it, and deleting the job does too. One
run per track at a time.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.api.jobs import _lyrics_job, run_behind_lock, start_run_task
from app.core.config import JOBS_DIR
from app.core.models import Job
from app.core.registry import persist as registry_persist
from app.pipeline import transcribe_on_demand as tod
from app.pipeline.lyrics_retime import current_run as current_retime

router = APIRouter()

# POST's 409 detail for each reason a track cannot be transcribed now.
_REFUSALS = {
    tod.OFF: "transcription is off",
    tod.NOT_READY: "job not ready",
    tod.USER_LYRICS: "user lyrics kept",
    tod.HAS_LYRICS: "lyrics already exist",
    tod.NO_VOCALS: "no vocals stem",
}


def _view(job: Job, job_dir: Path) -> dict[str, Any]:
    """Blocking: the run's state, whether a run could start now and why not,
    and where it would run."""
    run = tod.current_run(job.id)
    out = run.view() if run is not None else {"state": "idle"}
    reason = None if out["state"] == "running" else tod.unavailable_reason(job, job_dir)
    out["available"] = out["state"] != "running" and reason is None
    out["unavailable"] = reason
    out["device"] = tod.device(job)
    return out


def _work(job: Job, job_dir: Path, run: tod.TranscribeRun) -> Callable[[Callable[[], bool]], None]:
    def work(cancelled: Callable[[], bool]) -> None:
        run.state = tod.transcribe_now(job, job_dir, cancelled=cancelled, report=run.report)
        if run.state == tod.DONE:
            registry_persist(JOBS_DIR)

    return work


@router.get("/{job_id}/lyrics/transcribe")
async def get_lyrics_transcribe(job_id: str) -> dict:
    """Where a transcription of the track's lyrics stands: {"state": "idle" |
    "running" | "done" | "no_singing" | "failed" | "cancelled" | "has_lyrics"},
    with "phase" and "progress" (0 to 1) while running; "available" and
    "unavailable" (the reason it is not, or null) say whether POST would
    start one, and "device" ("cuda" or "cpu") where it would run."""
    job, job_dir = _lyrics_job(job_id)
    return await asyncio.to_thread(_view, job, job_dir)


@router.post("/{job_id}/lyrics/transcribe")
async def start_lyrics_transcribe(job_id: str) -> JSONResponse:
    """Transcribe the track's vocals into lyrics, in the background: 202 with
    the run's state, which GET .../lyrics/transcribe then follows.

    On a GPU or the CPU alike (about 30 s on a GPU, a few minutes on a CPU),
    under any transcribe_lyrics setting but "off". 409, with the reason, when
    the setting is "off", the job is not done, the track has lyrics (the
    user's own are never replaced), there is no vocals stem, or a
    transcription or a line-by-line timing of it is running."""
    job, job_dir = _lyrics_job(job_id)
    reason = await asyncio.to_thread(tod.unavailable_reason, job, job_dir)
    if reason is not None:
        raise HTTPException(status_code=409, detail=_REFUSALS[reason])
    retime = current_retime(job_id)
    if retime is not None and retime.state == "running":
        raise HTTPException(status_code=409, detail="lyrics timing running")
    run = tod.claim_run(job_id)
    if run is None:
        raise HTTPException(status_code=409, detail="transcription already running")
    start_run_task(run_behind_lock(job, run, _work(job, job_dir, run), "lyrics transcription"))
    return JSONResponse(await asyncio.to_thread(_view, job, job_dir), status_code=202)
