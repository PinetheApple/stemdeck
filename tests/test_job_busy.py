"""Moving the library and resetting the app wait for a Lead + Backing split
(upstream PR 878, #88).

Both looked only at the import queue. A split runs on a song that is already
"done", so it was invisible to them: a reset removed the folder the split
worker was writing into, and a move moved it away.

Emptying the Trash is not refused in the fork: its delete stops the split and
waits for it (api/jobs.py _stop_runs), which is the fork's behaviour.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core import registry as _registry
from app.core.models import VOCAL_SPLIT_DONE, VOCAL_SPLIT_RUNNING, Job
from tests.test_stems_location import _job_dir, client  # noqa: F401

JOB = "aaaaaaaaaaaa"
BUSY = {"code": "job_busy"}


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    yield
    _registry._jobs.clear()


def _song(vocal_split: str) -> Job:
    return _registry.register(Job(id=JOB, status="done", title="Song", vocal_split=vocal_split))


def test_reset_is_refused_while_a_split_runs():
    import app.main as main_mod

    _song(VOCAL_SPLIT_RUNNING)
    folder = main_mod.JOBS_DIR / JOB / "stems"
    folder.mkdir(parents=True)

    r = TestClient(main_mod.app).post("/api/reset")

    assert r.status_code == 409
    assert r.json()["code"] == BUSY["code"]
    assert folder.is_dir()
    assert _registry.get(JOB) is not None


def test_reset_goes_ahead_once_the_split_is_over():
    from app.main import app

    _song(VOCAL_SPLIT_DONE)

    r = TestClient(app).post("/api/reset")

    assert r.status_code == 200
    assert _registry.get(JOB) is None


def test_moving_the_library_is_refused_while_a_split_runs(client, tmp_path):  # noqa: F811
    _job_dir(client.jobs_dir, JOB)
    _song(VOCAL_SPLIT_RUNNING)
    target = tmp_path / "elsewhere"

    r = client.post("/api/settings/stems-location", json={"path": str(target)})

    assert r.status_code == 409
    assert r.json()["code"] == BUSY["code"]
    assert (client.jobs_dir / JOB).is_dir()
    assert not (target / JOB).exists()
    # The door is open again: the move goes ahead once the split is over.
    _registry.get(JOB).vocal_split = VOCAL_SPLIT_DONE
    assert client.post("/api/settings/stems-location", json={"path": str(target)}).is_success
