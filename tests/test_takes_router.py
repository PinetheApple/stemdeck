"""The takes routes are reachable through the app's own router."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.core.registry import _jobs
from tests._takes_helpers import JOB, add_done_job


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


def test_tracks_and_takes_through_the_app():
    from app.main import app

    add_done_job(cfg.JOBS_DIR)
    client = TestClient(app)
    track = client.post(f"/api/jobs/{JOB}/tracks", json={})
    assert track.status_code == 201
    listed = client.get(f"/api/jobs/{JOB}/takes")
    assert listed.status_code == 200
    assert [t["id"] for t in listed.json()["tracks"]] == [track.json()["id"]]
