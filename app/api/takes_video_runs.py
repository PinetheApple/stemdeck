"""Filmed-take renders in flight (#102, #99): one per take, kept in memory.

A render waits behind the pipeline lock like any on-demand run
(app/pipeline/runs.py), so it never shares the machine with a separation
and only one renders at a time. It writes a temp file beside the take; on
success that replaces render.mp4 and render.json records what made it, so
the finished export and its encoder survive a restart. A cancel or a
failure deletes the temp and keeps the previous render.mp4.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, ClassVar

from app.api.takes_video_plan import PlannedRender
from app.core.models import Job, JobCancelled
from app.core.settings import get_video_encoder
from app.core.song_folder import write_json_atomic
from app.core.take_video_config import (
    RENDER_FILE,
    RENDER_SIDECAR,
    RENDER_SIDECAR_VERSION,
    RENDER_STOP_WAIT_SEC,
    RENDER_TMP_TEMPLATE,
    STATUS_CANCELLED,
)
from app.core.takes_config import LOGGER_NAME
from app.pipeline.runs import DONE, FAILED, Run, RunBoard, run_behind_lock, start_run_task
from app.pipeline.take_video_ffmpeg import run_render
from app.pipeline.take_video_render import render_cmd
from app.pipeline.video_encoder import EncodeError, EncodeJob, EncodeOutcome, encode
from app.pipeline.video_process import STOP_CANCELLED

logger = logging.getLogger(LOGGER_NAME)

_KEY_SEP = "/"


@dataclass
class RenderRun(Run):
    cancelled_state: ClassVar[str] = STATUS_CANCELLED

    planned: PlannedRender | None = None
    error: str | None = None


RENDER_RUNS: RunBoard[RenderRun] = RunBoard(RenderRun)


def run_key(job_id: str, take_id: str) -> str:
    return f"{job_id}{_KEY_SEP}{take_id}"


def _record(planned: PlannedRender, outcome: EncodeOutcome, began: float) -> dict[str, Any]:
    plan = planned.plan
    return {
        "v": RENDER_SIDECAR_VERSION,
        "encoder": outcome.encoder,
        "family": outcome.family,
        "variant": outcome.variant,
        "device": outcome.device,
        "fallback_reason": outcome.fallback_reason,
        "size": planned.request["size"],
        "fps": plan.fps,
        "span": {"start_sec": plan.start_sec, "duration_sec": plan.duration_sec},
        "i_play": planned.request["i_play"],
        "request": planned.request,
        "inputs_sig": planned.inputs_sig,
        "made_at": time.time(),
        "elapsed_sec": time.monotonic() - began,
    }


def _encode_job(run: RenderRun, tmp: Path, stop) -> EncodeJob:
    plan = run.planned.plan

    def on_time(seconds: float) -> None:
        run.progress = min(1.0, seconds / plan.duration_sec)

    return EncodeJob(
        dest=tmp,
        width=plan.width,
        height=plan.height,
        fps=plan.fps,
        duration_sec=plan.duration_sec,
        build=partial(render_cmd, plan, tmp),
        run=lambda cmd, timeout, stall: run_render(cmd, timeout, stall, stop, on_time),
    )


def _render(job: Job, folder: Path, run: RenderRun, cancelled) -> None:
    """The blocking render; sets the run's outcome."""

    def stop() -> bool:
        return cancelled() or job.trashed_at is not None

    began = time.monotonic()
    tmp = folder / RENDER_TMP_TEMPLATE.format(token=uuid.uuid4().hex)
    try:
        outcome = encode(_encode_job(run, tmp, stop), get_video_encoder(), stop)
        os.replace(tmp, folder / RENDER_FILE)
        write_json_atomic(folder / RENDER_SIDECAR, _record(run.planned, outcome, began))
        run.progress = 1.0
        run.state = DONE
    except EncodeError as exc:
        if exc.code == STOP_CANCELLED:
            raise JobCancelled() from None
        logger.warning("[%s] render of %s failed: %s", job.id, folder.name, exc.code)
        run.error = exc.code
        run.state = FAILED
    finally:
        tmp.unlink(missing_ok=True)


def start_render(job: Job, folder: Path, planned: PlannedRender) -> RenderRun | None:
    """Queue a render of the take in `folder`; None while one already runs."""
    run = RENDER_RUNS.claim(run_key(job.id, folder.name))
    if run is None:
        return None
    run.planned = planned
    work = partial(_render, job, folder, run)
    start_run_task(run_behind_lock(job, run, work, f"render of take {folder.name}"))
    return run


def _stop(keys: list[str]) -> None:
    for key in keys:
        RENDER_RUNS.cancel(key)
    deadline = time.monotonic() + RENDER_STOP_WAIT_SEC
    for key in keys:
        if not RENDER_RUNS.wait_ended(key, max(0.0, deadline - time.monotonic())):
            logger.warning("render %s did not stop in time", key)


def cancel_job_renders(job_id: str) -> None:
    """Stop every render of a song's takes and wait (bounded) until each has
    let go of its files, so deleting the song does not race an ffmpeg."""
    prefix = run_key(job_id, "")
    keys = [k for k in list(RENDER_RUNS.runs) if k.startswith(prefix)]
    _stop(keys)
    for key in keys:
        RENDER_RUNS.forget(key)


def cancel_all_renders() -> None:
    """Shutdown: stop every render; each keeps its previous render.mp4."""
    _stop(list(RENDER_RUNS.runs))
