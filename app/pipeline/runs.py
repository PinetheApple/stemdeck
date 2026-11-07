"""On-demand runs on a finished job, one at a time per job and per kind.

A run is something the user asks for on a track that is already separated,
which takes a worker process and so waits its turn behind the pipeline lock:
timing the lyrics line by line (POST .../lyrics/retime, lyrics_retime.py) or
transcribing lyrics the track has none of (POST .../lyrics/transcribe,
transcribe_on_demand.py). Each kind keeps its runs on a RunBoard, by job id,
so GET can follow one, the job's cancel can stop it, and deleting the job can
wait for it to let go of the vocals.

A run is RUNNING from the moment it is claimed until its task
(run_behind_lock) ends it in a state of its own kind; a cancel ends it in
``cancelled_state``, at once when it is still waiting for the lock.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from collections.abc import Callable, Coroutine
from dataclasses import dataclass, field
from typing import ClassVar, Generic, TypeVar

from app.core.models import Job, JobCancelled
from app.core.registry import get as registry_get

logger = logging.getLogger("stemdeck.runs")

RUNNING = "running"
IDLE = "idle"
DONE = "done"
FAILED = "failed"
CANCELLED = "cancelled"


@dataclass
class Run:
    """One on-demand run of a job."""

    cancelled_state: ClassVar[str] = IDLE

    state: str = RUNNING
    progress: float = 0.0
    cancel: threading.Event = field(default_factory=threading.Event)
    # Set once it holds the pipeline lock: a run cancelled while waiting for
    # it is over at once.
    started: bool = False
    # Set when its task has finished, whatever the outcome: from then on it
    # holds no file of the job open (RunBoard.wait_ended).
    ended: threading.Event = field(default_factory=threading.Event)


R = TypeVar("R", bound=Run)


class RunBoard(Generic[R]):
    """The runs of one kind, by job id: the latest run of each job, kept
    after it ends so GET can tell how it ended."""

    def __init__(self, make: Callable[[], R]) -> None:
        self.runs: dict[str, R] = {}
        self._lock = threading.Lock()
        self._make = make

    def claim(self, job_id: str) -> R | None:
        """A new run for ``job_id``, or None while one is running already."""
        with self._lock:
            current = self.runs.get(job_id)
            if current is not None and current.state == RUNNING:
                return None
            run = self._make()
            self.runs[job_id] = run
            return run

    def current(self, job_id: str) -> R | None:
        with self._lock:
            return self.runs.get(job_id)

    def running(self, job_id: str) -> bool:
        run = self.current(job_id)
        return run is not None and run.state == RUNNING

    def cancel(self, job_id: str) -> bool:
        """Ask a running run of ``job_id`` to stop. True when one was running."""
        with self._lock:
            run = self.runs.get(job_id)
            if run is None or run.state != RUNNING:
                return False
            run.cancel.set()
            if not run.started:
                run.state = run.cancelled_state
            return True

    def wait_ended(self, job_id: str, timeout: float) -> bool:
        """Wait up to ``timeout`` seconds for a run of ``job_id`` that got as
        far as the vocals to let go of them. True when none holds them now.
        Deleting a job waits on this: on Windows a file the worker still has
        open cannot be removed, and the delete would fail and leave the
        folder."""
        with self._lock:
            run = self.runs.get(job_id)
        if run is None or not run.started:
            return True
        return run.ended.wait(timeout)

    def forget(self, job_id: str) -> None:
        with self._lock:
            self.runs.pop(job_id, None)


# Runs in flight, held so the event loop does not drop them.
_tasks: set[asyncio.Task] = set()


def start_run_task(coro: Coroutine[None, None, None]) -> None:
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def run_behind_lock(
    job: Job,
    run: Run,
    work: Callable[[Callable[[], bool]], None],
    what: str,
) -> None:
    """One on-demand run: behind the pipeline lock, so it never shares the
    GPU with a separation, and stopped by a cancel or the job's deletion.
    ``work``, blocking, is given that stop test and sets the run's outcome;
    a cancel ends the run in its cancelled_state, anything else it raises
    in FAILED."""
    # Imported here: runner imports lyrics_retime, which imports this module.
    from app.pipeline import runner

    def cancelled() -> bool:
        return run.cancel.is_set() or registry_get(job.id) is not job

    try:
        async with runner._pipeline_lock:
            run.started = True
            if cancelled():
                raise JobCancelled()
            await asyncio.to_thread(work, cancelled)
    except JobCancelled:
        run.state = run.cancelled_state
    except Exception:
        logger.exception("[%s] %s failed", job.id, what)
        run.state = FAILED
    finally:
        run.ended.set()
