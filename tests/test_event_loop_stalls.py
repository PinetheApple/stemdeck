"""Disk work stays off the event loop (upstream PRs 892 and 896, #88).

A failed job's quarantine, a cancelled job's folder removal and every
registry.json save ran on the event loop, and the save held the registry lock
while it wrote. On a big job or a library on a NAS every open page froze:
progress streams stopped and other requests waited.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import threading
import time
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest

from app.core import registry as _registry
from app.core.models import Job, JobCancelled
from app.core.registry import registry_path
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


# ─── a registry save holds neither the lock nor the loop (upstream PR 896) ───


def _slow_registry_write(monkeypatch) -> threading.Event:
    return _slow(monkeypatch, os, "replace", lambda src, dst: Path(dst).name == "registry.json")


def test_the_write_does_not_hold_the_registry_lock(tmp_path: Path, monkeypatch):
    """Every registry.get, from every request and stream, waited on the disk."""
    held: list[bool] = []
    real = os.replace

    def replace(src, dst):
        if Path(dst).name == "registry.json":
            held.append(_registry._lock.locked())
        real(src, dst)

    monkeypatch.setattr(os, "replace", replace)
    _registry.register(Job(id=JOB, status="done", title="Song"))

    _registry.persist(tmp_path)

    assert held == [False]
    saved = json.loads(registry_path(tmp_path).read_text(encoding="utf-8"))
    assert [record["id"] for record in saved["jobs"]] == [JOB]


def test_a_later_save_is_never_overwritten_by_an_earlier_one(tmp_path: Path, monkeypatch):
    job = _registry.register(Job(id=JOB, status="done", title="Before"))
    writing = _slow_registry_write(monkeypatch)
    first = threading.Thread(target=_registry.persist, args=(tmp_path,))
    first.start()
    assert writing.wait(1)
    job.title = "After"
    _registry.persist(tmp_path)
    first.join()

    saved = json.loads(registry_path(tmp_path).read_text(encoding="utf-8"))
    assert saved["jobs"][0]["title"] == "After"


def test_a_save_still_writing_cannot_undo_a_reset(tmp_path: Path, monkeypatch):
    _registry.register(Job(id=JOB, status="done", title="Song"))
    writing = _slow_registry_write(monkeypatch)
    save = threading.Thread(target=_registry.persist, args=(tmp_path,))
    save.start()
    assert writing.wait(1)
    _registry.reset_all(tmp_path)
    save.join()

    assert not registry_path(tmp_path).exists()


def test_a_timing_never_changes_a_dict_a_save_may_be_reading():
    """The pipeline thread added timings in place while a save serialised the
    same dict: "dictionary changed size during iteration", a 500."""
    job = Job(id=JOB, stage_timings={"download": 1.0})
    before = job.stage_timings

    _runner._lap(job, "separate", time.monotonic())

    assert before == {"download": 1.0}
    assert set(job.stage_timings) == {"download", "separate"}


async def test_a_route_saving_the_registry_leaves_the_loop_free(monkeypatch):
    from app.main import app

    writing = _slow_registry_write(monkeypatch)
    monkeypatch.setattr(jobqueue, "enqueue", lambda job_id: None)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://testserver"
    ) as client:
        request = client.post("/api/jobs", json={"url": "https://youtu.be/dQw4w9WgXcQ"})
        ticks = await _ticks_while(writing, request)

    assert ticks > 0, "the registry write blocked the event loop"


@pytest.mark.parametrize("ending", ["done", "cancelled", "failed"])
async def test_the_pipeline_saving_the_registry_leaves_the_loop_free(
    tmp_path: Path, monkeypatch, ending
):
    job = _registry.register(Job(id=JOB, title="Song", cancel_requested=ending == "cancelled"))
    (tmp_path / JOB).mkdir()

    def run(_job, _job_dir):
        if ending == "cancelled":
            raise JobCancelled()
        if ending == "failed":
            raise RuntimeError("worker died")

    writing = _slow_registry_write(monkeypatch)
    ticks = await _ticks_while(writing, _runner._run_async(job, tmp_path / JOB, tmp_path, run))

    assert ticks > 0, "the registry write blocked the event loop"
