"""A restored queue waits, paused, for Start. Restarting it never counts as the
job's one resume after a crash: only a run the queue starts does."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core import registry as _registry
from app.core.models import Job
from app.core.registry import _jobs
from app.core.registry import persist as persist_registry
from app.core.registry import restore as restore_registry

RESTARTS = 3
UPLOAD = "local:Waiting"
LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    _registry._pending_resume.clear()
    yield
    _jobs.clear()
    _registry._pending_resume.clear()


@pytest.mark.parametrize("status", ["queued", "separating"])
@pytest.mark.parametrize("source_url", [UPLOAD, LINK])
def test_restarts_without_start_keep_every_job(tmp_path: Path, status: str, source_url: str):
    """An error is not saved, so failing a waiting job dropped it from the
    Library. A stale "separating" on disk is no proof it ran either."""
    job = Job(id="abcdef000007", status=status, title="Waiting", source_url=source_url)
    _jobs[job.id] = job
    persist_registry(tmp_path)

    for _ in range(RESTARTS):
        _jobs.clear()
        restore_registry(tmp_path)
        assert _jobs[job.id].status == "queued"
        assert _registry.take_pending_resume() == [job.id]

    saved = json.loads(_registry.registry_path(tmp_path).read_text(encoding="utf-8"))
    assert [(r["id"], r["status"]) for r in saved["jobs"]] == [(job.id, "queued")]
