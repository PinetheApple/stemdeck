"""Lyrics transcribed on demand, for a track that has none (the Lyrics tab's
"Transcribe lyrics", app/pipeline/transcribe_on_demand.py).

Follows POST/GET .../lyrics/retime (app/api/jobs.py): POST starts a run in
the background, behind the pipeline lock, and answers 202; GET follows it;
the job's own POST .../cancel stops it, and deleting the job does too. One
lyrics run per track at a time, of either kind.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.api.jobs import (
    JOB_NOT_READY,
    LYRICS_TIMING_RUNNING,
    NO_VOCALS_STEM,
    TRANSCRIPTION_RUNNING,
    _lyrics_job,
)
from app.core.config import JOBS_DIR
from app.core.models import Job
from app.core.registry import persist as registry_persist
from app.pipeline import transcribe_on_demand as tod
from app.pipeline.lyrics_retime import RETIME_RUNS
from app.pipeline.runs import DONE, IDLE, RUNNING, run_behind_lock, start_run_task
from app.pipeline.transcribe import _device

router = APIRouter()

TRANSCRIPTION_OFF = "transcription is off"
USER_LYRICS_KEPT = "user lyrics kept"
LYRICS_EXIST = "lyrics already exist"

_REFUSALS = {
    tod.OFF: TRANSCRIPTION_OFF,
    tod.NOT_READY: JOB_NOT_READY,
    tod.USER_LYRICS: USER_LYRICS_KEPT,
    tod.HAS_LYRICS: LYRICS_EXIST,
    tod.NO_VOCALS: NO_VOCALS_STEM,
}


def _view(job: Job, job_dir: Path) -> dict[str, Any]:
    """Blocking: the run's state, whether a run could start now and why not,
    and where it would run."""
    run = tod.TRANSCRIBE_RUNS.current(job.id)
    out = run.view() if run is not None else {"state": IDLE}
    running = out["state"] == RUNNING
    reason = None if running else tod.unavailable_reason(job, job_dir)
    out["available"] = not running and reason is None
    out["unavailable"] = reason
    out["device"] = _device(job)
    return out


def _work(
    job: Job,
    job_dir: Path,
    run: tod.TranscribeRun,
) -> Callable[[Callable[[], bool]], None]:
    def work(cancelled: Callable[[], bool]) -> None:
        run.state = tod.transcribe_now(
            job,
            job_dir,
            cancelled=cancelled,
            report=run.report,
        )
        if run.state == DONE:
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
    if RETIME_RUNS.running(job_id):
        raise HTTPException(status_code=409, detail=LYRICS_TIMING_RUNNING)
    run = tod.TRANSCRIBE_RUNS.claim(job_id)
    if run is None:
        raise HTTPException(status_code=409, detail=TRANSCRIPTION_RUNNING)
    start_run_task(
        run_behind_lock(
            job,
            run,
            _work(job, job_dir, run),
            "lyrics transcription",
        )
    )
    return JSONResponse(await asyncio.to_thread(_view, job, job_dir), status_code=202)
