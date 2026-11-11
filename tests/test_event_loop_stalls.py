"""Disk work stays off the event loop (upstream PRs 892 and 896, #88).

A failed job's quarantine, a cancelled job's folder removal and every
registry.json save ran on the event loop, and the save held the registry lock
while it wrote. On a big job or a library on a NAS every open page froze:
progress streams stopped and other requests waited.
"""

from __future__ import annotations

import asyncio
import contextlib
import shutil
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core import registry as _registry
from app.core.models import Job, JobCancelled
from app.pipeline import jobqueue
from app.pipeline import runner as _runner

JOB = "a1b2c3d4e5f6"
SLOW_SEC = 0.2


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()


def _slow(monkeypatch, module, name: str, only=lambda *a, **k: True) -> threading.Event:
    """Make `module.name` take SLOW_SEC for the calls `only` picks. The event
    is set while one is in progress."""
    real = getattr(module, name)
    busy = threading.Event()

    def slow(*args, **kwargs):
        if not only(*args, **kwargs):
            return real(*args, **kwargs)
        busy.set()
        try:
            time.sleep(SLOW_SEC)
            return real(*args, **kwargs)
        finally:
            busy.clear()

    monkeypatch.setattr(module, name, slow)
    return busy


async def _ticks_while(busy: threading.Event, run) -> int:
    """How often another coroutine got to run while `busy` was set."""
    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            if busy.is_set():
                ticks += 1
            await asyncio.sleep(0.005)

    task = asyncio.create_task(ticker())
    try:
        await run
    finally:
        task.cancel()
    return ticks


def _failing_job(root: Path) -> Job:
    job = Job(id=JOB, source_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    _registry.register(job)
    (root / JOB / "stems").mkdir(parents=True)
    (root / JOB / "stems" / "vocals.wav").write_bytes(b"RIFF")
    return job


# ─── cleanup after a failed or cancelled job (upstream PR 892) ───


async def test_a_failed_jobs_quarantine_leaves_the_loop_free(tmp_path: Path, monkeypatch):
    """The first "error" a page sees must already carry error_detail and the
    evidence: the page records the failure then."""
    job = _failing_job(tmp_path)
    removing = _slow(monkeypatch, shutil, "rmtree")
    seen: list[tuple[str | None, bool]] = []

    async def watch():
        while not seen:
            if job.status == "error":
                evidence = (tmp_path / "failed" / JOB / "error.txt").is_file()
                seen.append((job.error_detail, evidence))
            await asyncio.sleep(0.001)

    watcher = asyncio.create_task(watch())
    with patch("app.pipeline.runner._run_blocking", side_effect=RuntimeError("worker died")):
        ticks = await _ticks_while(removing, _runner.run_pipeline(job, job.source_url, tmp_path))
    await asyncio.wait_for(watcher, 1)

    assert ticks > 0, "the quarantine blocked the event loop"
    assert seen[0][0] is not None
    assert seen[0][1]


async def test_a_cancelled_jobs_folder_removal_leaves_the_loop_free(tmp_path: Path, monkeypatch):
    job = Job(id=JOB, cancel_requested=True)
    _registry.register(job)
    job_dir = tmp_path / JOB
    (job_dir / "stems").mkdir(parents=True)

    def run(_job, _job_dir):
        raise JobCancelled()

    removing = _slow(monkeypatch, shutil, "rmtree")
    ticks = await _ticks_while(removing, _runner._run_async(job, job_dir, tmp_path, run))

    assert ticks > 0, "the cleanup blocked the event loop"
    assert not job_dir.exists()


async def test_a_job_cancelled_before_its_claim_is_cleaned_up_off_the_loop(monkeypatch):
    """The queue worker removes a job cancelled between pop and claim (#520)."""
    job = Job(id=JOB, status="queued", cancel_requested=True)
    _registry.register(job)
    jobqueue.enqueue(job.id)
    (jobqueue.JOBS_DIR / JOB).mkdir(parents=True)
    removing = _slow(monkeypatch, shutil, "rmtree")

    async def settle():
        task = jobqueue.start_worker()
        try:
            while job.status != "cancelled" or (jobqueue.JOBS_DIR / JOB).exists():
                await asyncio.sleep(0.01)
        finally:
            jobqueue.request_stop()
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    ticks = await _ticks_while(removing, asyncio.wait_for(settle(), 5))

    assert ticks > 0, "the cleanup blocked the event loop"
