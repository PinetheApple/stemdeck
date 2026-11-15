"""Filmed-take renders in flight: one per take, kept in memory.

A render waits behind the pipeline lock like any on-demand run
(app/pipeline/runs.py), so it never shares the machine with a separation
and only one renders at a time. It writes a temp file beside the take. On
success render.json is written first, naming the new file by size and
mtime, then the temp replaces render.mp4; a reader trusts render.json only
for the file it names. A cancel or a failure deletes the temp and keeps the
previous render.mp4. Temps a crash left behind are removed when that take
renders again, and once per process for every take.
"""

from __future__ import annotations

import errno
import logging
import os
import re
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from functools import partial
from pathlib import Path
from typing import Any, ClassVar

from app.api.takes_video_plan import PlannedRender
from app.core.models import Job, JobCancelled
from app.core.settings import get_video_encoder
from app.core.song_folder import write_json_atomic
from app.core.take_video_config import (
    ERROR_DISK_FULL,
    ERROR_FAILED,
    ERROR_FILES,
    RENDER_FILE,
    RENDER_SIDECAR,
    RENDER_SIDECAR_VERSION,
    RENDER_STOP_WAIT_SEC,
    RENDER_TMP_GLOB,
    RENDER_TMP_TEMPLATE,
)
from app.core.takes_config import LOGGER_NAME, TAKES_DIRNAME
from app.core.video_config import TIMEOUT_VIDEO_RENDER_MAX
from app.pipeline.runs import (
    CANCELLED,
    DONE,
    FAILED,
    Run,
    RunBoard,
    run_behind_lock,
    start_run_task,
)
from app.pipeline.take_video_ffmpeg import run_render
from app.pipeline.take_video_render import RenderPlan, render_cmd
from app.pipeline.video_encoder import EncodeError, EncodeJob, EncodeOutcome, encode
from app.pipeline.video_probe import CODE_EXIT, classify_failure
from app.pipeline.video_process import STOP_CANCELLED

logger = logging.getLogger(LOGGER_NAME)

_KEY_SEP = "/"
_DISK_FULL_ERRNOS = (errno.ENOSPC, errno.EDQUOT)
_DISK_FULL_RE = re.compile(r"no space left on device|disk quota exceeded", re.IGNORECASE)
# Older than the longest render allowed, so no render can still be writing it.
STALE_TEMP_AGE_SEC = TIMEOUT_VIDEO_RENDER_MAX
_swept_at_start = False


@dataclass
class RenderRun(Run):
    cancelled_state: ClassVar[str] = CANCELLED

    planned: PlannedRender | None = None
    error: str | None = None
    tmp: Path | None = None


RENDER_RUNS: RunBoard[RenderRun] = RunBoard(RenderRun)


def run_key(job_id: str, take_id: str) -> str:
    return f"{job_id}{_KEY_SEP}{take_id}"


def span_of(plan: RenderPlan) -> dict[str, float]:
    return {"start_sec": plan.start_sec, "duration_sec": plan.duration_sec}


def file_identity(path: Path) -> dict[str, int]:
    st = path.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def error_code(exc: BaseException) -> str:
    """A failure as the code the render view shows: a full disk, the
    encoder's own reason for an ffmpeg exit, or what stopped it."""
    if isinstance(exc, EncodeError):
        if exc.code != CODE_EXIT:
            return exc.code
        if _DISK_FULL_RE.search(exc.stderr):
            return ERROR_DISK_FULL
        return classify_failure(exc.stderr)[0]
    if isinstance(exc, OSError):
        return ERROR_DISK_FULL if exc.errno in _DISK_FULL_ERRNOS else ERROR_FILES
    return ERROR_FAILED


def _record(run: RenderRun, outcome: EncodeOutcome, began: float) -> dict[str, Any]:
    planned = run.planned
    return {
        "v": RENDER_SIDECAR_VERSION,
        "encoder": outcome.encoder,
        "family": outcome.family,
        "variant": outcome.variant,
        "device": outcome.device,
        "fallback_reason": outcome.fallback_reason,
        "size": planned.request["size"],
        "fps": planned.plan.fps,
        "span": span_of(planned.plan),
        "i_play": planned.request["i_play"],
        "request": planned.request,
        "inputs_sig": planned.inputs_sig,
        "file": file_identity(run.tmp),
        "made_at": time.time(),
        "elapsed_sec": time.monotonic() - began,
    }


def _encode_job(run: RenderRun, stop: Callable[[], bool]) -> EncodeJob:
    plan = run.planned.plan

    def on_time(seconds: float) -> None:
        run.progress = min(1.0, seconds / plan.duration_sec)

    return EncodeJob(
        dest=run.tmp,
        width=plan.width,
        height=plan.height,
        fps=plan.fps,
        duration_sec=plan.duration_sec,
        build=partial(render_cmd, plan, run.tmp),
        run=lambda cmd, timeout, stall: run_render(cmd, timeout, stall, stop, on_time),
    )


def _publish(folder: Path, run: RenderRun, outcome: EncodeOutcome, began: float) -> None:
    write_json_atomic(folder / RENDER_SIDECAR, _record(run, outcome, began))
    os.replace(run.tmp, folder / RENDER_FILE)


def _fail(job: Job, folder: Path, run: RenderRun, exc: BaseException) -> None:
    run.error = error_code(exc)
    run.state = FAILED
    logger.warning("[%s] render of %s failed: %s", job.id, folder.name, run.error, exc_info=exc)


def _render(job: Job, folder: Path, run: RenderRun, cancelled: Callable[[], bool]) -> None:
    """The blocking render; sets the run's outcome."""

    def stop() -> bool:
        return cancelled() or job.trashed_at is not None

    began = time.monotonic()
    remove_take_temps(folder)
    run.tmp = folder / RENDER_TMP_TEMPLATE.format(token=uuid.uuid4().hex)
    try:
        outcome = encode(_encode_job(run, stop), get_video_encoder(), stop)
        _publish(folder, run, outcome, began)
        run.progress = 1.0
        run.state = DONE
    except EncodeError as exc:
        if exc.code == STOP_CANCELLED:
            raise JobCancelled() from None
        _fail(job, folder, run, exc)
    # Any other failure still needs a code the user can be shown.
    except Exception as exc:
        _fail(job, folder, run, exc)
    finally:
        run.tmp.unlink(missing_ok=True)


def start_render(job: Job, folder: Path, planned: PlannedRender) -> RenderRun | None:
    """Queue a render of the take in `folder`; None while one already runs."""
    run = RENDER_RUNS.claim(run_key(job.id, folder.name))
    if run is None:
        return None
    run.planned = planned
    work = partial(_render, job, folder, run)
    start_run_task(run_behind_lock(job, run, work, f"render of take {folder.name}"))
    return run


def remove_take_temps(folder: Path) -> None:
    """A take's render temps; its own new render has not started one yet."""
    for path in folder.glob(RENDER_TMP_GLOB):
        path.unlink(missing_ok=True)


def sweep_stale_temps(jobs_dir: Path) -> None:
    """Remove every take's render temps a crash left, sparing running renders."""
    live = {run.tmp for run in list(RENDER_RUNS.runs.values()) if run.tmp is not None}
    cutoff = time.time() - STALE_TEMP_AGE_SEC
    for path in jobs_dir.glob(f"*/{TAKES_DIRNAME}/*/{RENDER_TMP_GLOB}"):
        try:
            if path not in live and path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            logger.warning("could not remove the render temp %s", path, exc_info=True)


def sweep_once(jobs_dir: Path) -> None:
    """sweep_stale_temps, the first time a render route is used."""
    global _swept_at_start
    if not _swept_at_start:
        _swept_at_start = True
        sweep_stale_temps(jobs_dir)


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
