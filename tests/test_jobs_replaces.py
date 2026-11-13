"""A re-import replaces the old copy on the server.

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
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.core import registry, setlists
from app.core.models import Job, JobCancelled
from app.core.registry import _jobs
from app.core.song_folder import STEMS_COMPLETE
from app.pipeline import runner
from app.pipeline.runner import run_pipeline
from tests.test_versions_api import THREE_OPEN, THREE_VERSIONS

OLD_ID = "0123456789ab"
NEW_ID = "ba9876543210"
URL = "https://youtu.be/dQw4w9WgXcQ"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@contextmanager
def _started_app():
    with (
        patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None),
        patch("app.api.jobs._probe_duration", return_value=60.0),
    ):
        from app.main import app

        with TestClient(app) as c:
            yield c


@pytest.fixture
def client():
    with _started_app() as c:
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


@pytest.mark.parametrize("with_files", [True, False])
async def test_the_new_copy_takes_the_old_ones_place_in_every_setlist(client, with_files):
    _old_job(with_files=with_files)
    swapped = setlists.create(cfg.JOBS_DIR, "Gig", ["aaaaaaaaaaaa", OLD_ID, "bbbbbbbbbbbb"])
    already = setlists.create(cfg.JOBS_DIR, "Rehearsal", [NEW_ID, OLD_ID, "cccccccccccc"])
    untouched = setlists.create(cfg.JOBS_DIR, "Other", ["dddddddddddd"])
    await _finish(_new_job())
    songs = {s["id"]: s["song_ids"] for s in setlists.list_all(cfg.JOBS_DIR)}
    assert songs[swapped["id"]] == ["aaaaaaaaaaaa", NEW_ID, "bbbbbbbbbbbb"]
    assert songs[already["id"]] == [NEW_ID, "cccccccccccc"]
    assert songs[untouched["id"]] == ["dddddddddddd"]


async def test_a_new_job_that_fails_leaves_the_setlists(client):
    _old_job()
    gig = setlists.create(cfg.JOBS_DIR, "Gig", [OLD_ID])
    await _finish(_new_job(), _fail)
    assert setlists.list_all(cfg.JOBS_DIR)[0]["song_ids"] == gig["song_ids"]


async def test_a_failing_done_hook_is_logged_and_the_job_stays_done(monkeypatch, caplog):
    def broken(job):
        raise RuntimeError("hook blew up")

    monkeypatch.setattr(runner, "_on_done", broken)
    new = _new_job()
    await _finish(new)
    assert new.status == "done"
    assert "hook blew up" in caplog.text


@pytest.mark.parametrize("with_files", [True, False])
async def test_replaces_is_cleared_once_settled(client, with_files):
    _old_job(with_files=with_files)
    await _finish(_new_job())
    assert _jobs[NEW_ID].replaces is None
    assert _persisted(NEW_ID)["replaces"] is None


async def test_replaces_is_cleared_when_the_old_copy_is_left_as_it_is(client):
    await _finish(_new_job())
    assert _jobs[NEW_ID].replaces is None


async def test_a_failing_done_hook_leaves_replaces_for_the_next_start(monkeypatch):
    _old_job()
    monkeypatch.setattr("app.api.jobs.setlists_replace_song", _fail)
    await _finish(_new_job())
    assert _jobs[NEW_ID].replaces == OLD_ID
    assert _persisted(NEW_ID)["replaces"] == OLD_ID


def test_a_replacement_left_pending_is_settled_at_startup():
    _old_job()
    registry.register(Job(id=NEW_ID, status="done", title="New copy", replaces=OLD_ID))
    _restart()
    with _started_app() as c:
        states = {s["job_id"]: s for s in c.get("/api/jobs").json()}
    assert _jobs[OLD_ID].trashed_at is not None
    assert states[NEW_ID]["replaces"] is None
    assert _persisted(NEW_ID)["replaces"] is None


def test_a_new_copy_trashed_before_the_restart_forgets_replaces():
    _old_job()
    registry.register(
        Job(id=NEW_ID, status="done", title="New copy", replaces=OLD_ID, trashed_at=1.0)
    )
    _restart()
    with _started_app():
        pass
    assert _jobs[NEW_ID].replaces is None
    assert _jobs[OLD_ID].trashed_at is None


def test_a_crash_before_the_done_persist_still_settles_the_old_copy():
    _old_job()
    _new_job()
    stems = cfg.JOBS_DIR / NEW_ID / "stems"
    stems.mkdir(parents=True)
    (stems / "vocals.wav").write_bytes(b"RIFF")
    (stems / STEMS_COMPLETE).write_text("", encoding="utf-8")
    _restart()
    assert _jobs[NEW_ID].status == "done"
    with _started_app():
        pass
    assert _jobs[OLD_ID].trashed_at is not None
    assert _jobs[NEW_ID].replaces is None


async def test_an_old_copy_restored_after_settling_stays_restored():
    _old_job()
    new = _new_job()
    new.title = "New copy"
    await _finish(new)
    with _started_app() as c:
        assert c.post(f"/api/jobs/{OLD_ID}/restore").status_code == 200
    _restart()
    with _started_app():
        pass
    assert _jobs[NEW_ID].status == "done"
    assert _jobs[OLD_ID].trashed_at is None


def _restart() -> None:
    registry.persist(cfg.JOBS_DIR)
    _jobs.clear()
    registry.restore(cfg.JOBS_DIR)


def _persisted(job_id: str) -> dict:
    path = registry.registry_path(cfg.JOBS_DIR)
    records = json.loads(path.read_text(encoding="utf-8"))["jobs"]
    return next(record for record in records if record["id"] == job_id)


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


@pytest.mark.parametrize("with_files", [True, False])
async def test_a_reimport_of_a_song_with_versions_leaves_one_visible_copy(client, with_files):
    old = _old_job(with_files=with_files)
    old.versions, old.open_version = THREE_VERSIONS, THREE_OPEN
    new = _new_job()
    new.title = "New copy"
    await _finish(new)

    listed = client.get("/api/jobs").json()
    assert [s["job_id"] for s in listed] == [NEW_ID]
    assert [v["id"] for v in listed[0]["versions"]] == ["main"]
    assert _jobs[NEW_ID].versions is None
    if with_files:
        assert _jobs[OLD_ID].trashed_at is not None
        assert (_jobs[OLD_ID].versions, _jobs[OLD_ID].open_version) == (THREE_VERSIONS, THREE_OPEN)
    else:
        assert OLD_ID not in _jobs
