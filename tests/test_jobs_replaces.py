"""A re-import replaces the old copy on the server (#38).

Re-importing a song, or "Sync again" on one whose files are gone, made a new
job and left the old one in the registry, so GET /api/jobs listed both and the
desktop library flipped between them while the phone showed two. A new job now
names the job it replaces, and the server alone settles it once the new job is
done: an old copy with no files is deleted, one that still plays goes to the
Trash, because it may carry the user's sections, lyrics and tempo edits.
"""

from __future__ import annotations

import io
import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.core import registry
from app.core.models import Job, JobCancelled
from app.core.registry import _jobs
from app.pipeline.runner import run_pipeline

OLD_ID = "0123456789ab"
NEW_ID = "ba9876543210"
URL = "https://youtu.be/dQw4w9WgXcQ"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client():
    with (
        patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None),
        patch("app.api.jobs._probe_duration", return_value=60.0),
    ):
        from app.main import app

        with TestClient(app) as c:
            yield c


def _old_job(*, status: str = "done", with_files: bool = True) -> Job:
    job = Job(id=OLD_ID, status=status, title="Old copy")
    registry.register(job)
    if with_files:
        stems = cfg.JOBS_DIR / OLD_ID / "stems"
        stems.mkdir(parents=True)
        (stems / "vocals.wav").write_bytes(b"RIFF")
    return job


def _new_job(replaces: str | None = OLD_ID) -> Job:
    return registry.register(Job(id=NEW_ID, status="processing", replaces=replaces))


async def _finish(job: Job, outcome=None) -> None:
    with patch("app.pipeline.runner._run_blocking", side_effect=outcome):
        await run_pipeline(job, URL, cfg.JOBS_DIR)


# ── creation ──


def test_an_unknown_old_id_is_ignored(client):
    r = client.post("/api/jobs", json={"url": URL, "replaces": "ffffffffffff"})
    assert r.status_code == 200
    assert _jobs[r.json()["job_id"]].replaces is None


@pytest.mark.parametrize("bad", ["../etc/passwd", "ABCDEF012345", "0123", 12])
def test_a_malformed_old_id_is_rejected(client, bad):
    r = client.post("/api/jobs", json={"url": URL, "replaces": bad})
    assert r.status_code == 422
    assert _jobs == {}


@pytest.mark.parametrize("status", ["queued", "separating"])
def test_replacing_a_waiting_or_running_job_is_refused(client, status):
    _old_job(status=status, with_files=False)
    r = client.post("/api/jobs", json={"url": URL, "replaces": OLD_ID})
    assert r.status_code == 409
    assert list(_jobs) == [OLD_ID]


def test_a_copy_already_being_replaced_is_refused(client):
    _old_job()
    assert client.post("/api/jobs", json={"url": URL, "replaces": OLD_ID}).status_code == 200
    r = client.post("/api/jobs", json={"url": URL, "replaces": OLD_ID})
    assert r.status_code == 409
    assert len(_jobs) == 2


def test_an_upload_can_replace_a_song(client):
    _old_job()
    r = client.post(
        "/api/jobs",
        files={"file": ("song.mp3", io.BytesIO(b"\xff\xfb" * 64), "audio/mpeg")},
        data={"replaces": OLD_ID},
    )
    assert r.status_code == 200
    assert _jobs[r.json()["job_id"]].replaces == OLD_ID


def test_replaces_survives_a_restart_and_is_reported(client):
    _old_job()
    registry.register(Job(id=NEW_ID, status="done", title="New copy", replaces=OLD_ID))
    registry.persist(cfg.JOBS_DIR)
    _jobs.clear()
    registry.restore(cfg.JOBS_DIR)
    assert _jobs[NEW_ID].replaces == OLD_ID
    states = {s["job_id"]: s for s in client.get("/api/jobs").json()}
    assert states[NEW_ID]["replaces"] == OLD_ID
    assert states[OLD_ID]["replaces"] is None


# ── when the new job finishes ──


async def test_done_deletes_an_old_record_whose_files_are_gone(client):
    _old_job(with_files=False)
    await _finish(_new_job())
    assert OLD_ID not in _jobs
    persisted = json.loads(registry.registry_path(cfg.JOBS_DIR).read_text(encoding="utf-8"))
    assert [record["id"] for record in persisted["jobs"]] == [NEW_ID]


async def test_done_trashes_an_old_copy_that_still_plays(client):
    _old_job()
    await _finish(_new_job())
    assert _jobs[OLD_ID].trashed_at is not None
    assert (cfg.JOBS_DIR / OLD_ID / "stems" / "vocals.wav").is_file()
    assert _jobs[NEW_ID].trashed_at is None


async def test_an_old_copy_trashed_meanwhile_is_left_alone(client):
    old = _old_job(with_files=False)
    old.trashed_at = 1.0
    await _finish(_new_job())
    assert _jobs[OLD_ID].trashed_at == 1.0


def _fail(*args, **kwargs):
    raise RuntimeError("download blew up")


def _cancel(*args, **kwargs):
    _jobs[NEW_ID].cancel_requested = True
    raise JobCancelled()


def _trash(*args, **kwargs):
    _jobs[NEW_ID].cancel_requested = True
    _jobs[NEW_ID].stop_requested = True
    _jobs[NEW_ID].trashed_at = 1.0
    raise JobCancelled()


@pytest.mark.parametrize("outcome", [_fail, _cancel, _trash])
@pytest.mark.parametrize("with_files", [True, False])
async def test_a_new_job_that_does_not_finish_leaves_the_old_copy(client, outcome, with_files):
    _old_job(with_files=with_files)
    await _finish(_new_job(), outcome)
    assert _jobs[NEW_ID].status != "done"
    assert _jobs[OLD_ID].trashed_at is None


async def test_a_new_job_trashed_as_it_finished_leaves_the_old_copy(client):
    _old_job()
    new = _new_job()
    new.trashed_at = 1.0
    await _finish(new)
    assert _jobs[NEW_ID].status == "done"
    assert _jobs[OLD_ID].trashed_at is None
