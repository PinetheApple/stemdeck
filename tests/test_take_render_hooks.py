"""Filmed-take renders stop with their song and with the server: deleting,
trashing or replacing a song runs _stop_runs, and shutdown runs the app's
lifespan teardown."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.api import jobs as jobs_api
from app.core.models import Job

JOB_ID = "abcdefabcdef"


def test_stopping_a_songs_runs_stops_its_renders(monkeypatch):
    stopped: list[str] = []
    monkeypatch.setattr(jobs_api, "cancel_job_renders", stopped.append)
    jobs_api._stop_runs(Job(id=JOB_ID), with_lyrics=False)
    assert stopped == [JOB_ID]


def test_shutdown_stops_every_render(monkeypatch):
    import app.main as main

    calls: list[bool] = []
    monkeypatch.setattr(main, "cancel_all_renders", lambda: calls.append(True))
    with TestClient(main.app):
        assert calls == []
    assert calls == [True]
