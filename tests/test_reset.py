from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.api.jobs import LYRICS_RUNNING_BLOCKS_RESET
from app.core.models import Job
from app.core.registry import _jobs, _procs
from app.core.registry import reset_all as reset_registry


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    _procs.clear()
    yield
    _jobs.clear()
    _procs.clear()


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


# ─── registry.reset_all() ──────────────────────────────────────────────────


def test_reset_all_clears_registry_and_deletes_job_dirs(tmp_path):
    jobs_dir = tmp_path / "jobs"
    job = Job(id="abcdefabcdef", status="done", title="Old song")
    _jobs[job.id] = job
    job_dir = jobs_dir / job.id
    (job_dir / "stems").mkdir(parents=True)
    (job_dir / "stems" / "vocals.wav").write_bytes(b"RIFF")
    (jobs_dir / "registry.json").write_text(json.dumps({"version": 1, "jobs": [job.to_record()]}))
    # A quarantined failure, as the runner leaves it: error.txt in failed/<id>.
    (jobs_dir / "failed" / "abcdefabcde1").mkdir(parents=True)
    (jobs_dir / "failed" / "abcdefabcde1" / "error.txt").write_text("evidence")

    reset_registry(jobs_dir)

    assert _jobs == {}
    assert list(jobs_dir.iterdir()) == []  # every entry StemDeck made is gone


def test_reset_all_clears_active_procs(tmp_path):
    from unittest.mock import MagicMock

    _procs["abcdefabcdef"] = MagicMock()
    reset_registry(tmp_path)
    assert _procs == {}


def test_reset_all_on_missing_dir_is_a_noop(tmp_path):
    missing = tmp_path / "does-not-exist"
    reset_registry(missing)  # must not raise


# ─── POST /api/reset ────────────────────────────────────────────────────────


def test_reset_endpoint_works_without_desktop_mode(client, monkeypatch, tmp_path):
    """Available in server mode too -- gated by the same network_gate
    middleware every other settings-mutating endpoint already relies on, not
    a desktop-only restriction."""
    monkeypatch.delenv("STEMDECK_DESKTOP", raising=False)
    monkeypatch.setattr("app.main.JOBS_DIR", tmp_path)
    job = Job(id="abcdefabcded", status="done")
    _jobs[job.id] = job
    (tmp_path / job.id).mkdir()

    r = client.post("/api/reset")

    assert r.status_code == 200
    # "undeleted" reports what reset could not remove; 0 on a clean reset (#521).
    assert r.json() == {"ok": True, "undeleted": 0}
    assert _jobs == {}
    assert not (tmp_path / job.id).exists()


def test_reset_endpoint_rejects_active_job(client, monkeypatch, tmp_path):
    monkeypatch.setattr("app.main.JOBS_DIR", tmp_path)
    job = Job(id="abcdefabcdee", status="separating")
    _jobs[job.id] = job

    r = client.post("/api/reset")

    assert r.status_code == 409
    assert job.id in _jobs  # nothing was touched


def test_reset_endpoint_succeeds(client, monkeypatch, tmp_path):
    monkeypatch.setattr("app.main.JOBS_DIR", tmp_path)
    job = Job(id="abcdefabcdea", status="done")
    _jobs[job.id] = job
    (tmp_path / job.id).mkdir()

    r = client.post("/api/reset")

    assert r.status_code == 200
    # "undeleted" reports what reset could not remove; 0 on a clean reset (#521).
    assert r.json() == {"ok": True, "undeleted": 0}
    assert _jobs == {}
    assert not (tmp_path / job.id).exists()


def test_reset_endpoint_allows_only_terminal_jobs(client, monkeypatch, tmp_path):
    """done/error/cancelled jobs never block a reset -- only genuinely active
    ones (queued through processing) do."""
    monkeypatch.setattr("app.main.JOBS_DIR", tmp_path)
    for i, status in enumerate(("done", "error", "cancelled")):
        _jobs[f"abcdefabcd{i:02x}"] = Job(id=f"abcdefabcd{i:02x}", status=status)

    r = client.post("/api/reset")

    assert r.status_code == 200


def test_reset_endpoint_rejects_a_lyrics_run(client, monkeypatch, tmp_path, lyrics_board):
    monkeypatch.setattr("app.main.JOBS_DIR", tmp_path)
    job = Job(id="abcdefabcdeb", status="done")
    _jobs[job.id] = job
    (tmp_path / job.id).mkdir()
    lyrics_board.claim(job.id)

    r = client.post("/api/reset")

    assert r.status_code == 409
    assert r.json()["detail"] == LYRICS_RUNNING_BLOCKS_RESET
    assert job.id in _jobs and (tmp_path / job.id).is_dir()


def test_reset_endpoint_ignores_a_lyrics_run_that_ended(
    client, monkeypatch, tmp_path, lyrics_board
):
    from app.pipeline.runs import FAILED

    monkeypatch.setattr("app.main.JOBS_DIR", tmp_path)
    job = Job(id="abcdefabcdeb", status="done")
    _jobs[job.id] = job
    lyrics_board.claim(job.id).state = FAILED

    r = client.post("/api/reset")

    assert r.status_code == 200
