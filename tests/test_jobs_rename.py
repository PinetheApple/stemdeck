"""Renaming a song: the user's title and artist win over the detected ones.

They are kept beside the detected values (user_title, user_artist), so the
pipeline and the tag backfill can rewrite what they detect without undoing the
rename, and null puts the detected value back.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import jobs as jobs_mod
from app.core.config import SONG_NAME_MAX_CHARS
from app.core.models import Job, _set
from app.core.registry import _jobs, persist, register, restore
from app.main import app
from app.pipeline.runner import _write_metadata

JOB_ID = "aaaaaaaaaaaa"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _done(**fields) -> Job:
    job = Job(id=JOB_ID, status="done", title="detected title", **fields)
    register(job)
    job_dir = cfg.JOBS_DIR / JOB_ID
    (job_dir / "stems").mkdir(parents=True, exist_ok=True)
    (job_dir / "stems" / "vocals.wav").write_bytes(b"")
    _write_metadata(job, job_dir)
    return job


def _metadata() -> dict:
    return json.loads((cfg.JOBS_DIR / JOB_ID / "metadata.json").read_text(encoding="utf-8"))


def test_rename_wins_in_the_library(client: TestClient) -> None:
    _done(audio_tags={"artist": "Tagged Band"})
    resp = client.patch(f"/api/jobs/{JOB_ID}", json={"title": "  My Title ", "artist": "Me"})
    assert resp.status_code == 200
    state = resp.json()
    assert state["title"] == "My Title"
    assert state["detected_title"] == "detected title"
    assert state["user_title"] == "My Title"
    assert state["user_artist"] == "Me"
    assert state["audio_tags"] == {"artist": "Tagged Band"}

    listed = client.get("/api/jobs").json()[0]
    assert (listed["title"], listed["user_artist"]) == ("My Title", "Me")
    assert _metadata()["user_title"] == "My Title"
    assert _metadata()["title"] == "detected title"


def test_one_field_leaves_the_other(client: TestClient) -> None:
    _done(user_title="Kept")
    resp = client.patch(f"/api/jobs/{JOB_ID}", json={"artist": "Me"})
    assert resp.json()["user_title"] == "Kept"
    assert resp.json()["user_artist"] == "Me"


def test_null_restores_the_detected_value(client: TestClient) -> None:
    _done(user_title="Mine", user_artist="Me")
    resp = client.patch(f"/api/jobs/{JOB_ID}", json={"title": None, "artist": None})
    state = resp.json()
    assert state["title"] == "detected title"
    assert state["user_title"] is None
    assert state["user_artist"] is None
    assert _metadata()["user_title"] is None


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"title": ""},
        {"artist": "   "},
        {"title": "x" * (SONG_NAME_MAX_CHARS + 1)},
        {"title": 5},
        {"name": "Mine"},
    ],
)
def test_bad_bodies_are_refused(client: TestClient, body: dict) -> None:
    _done()
    assert client.patch(f"/api/jobs/{JOB_ID}", json=body).status_code == 422
    assert client.get(f"/api/jobs/{JOB_ID}").json()["user_title"] is None


@pytest.mark.parametrize("job_id", ["999999999999", "not-a-job-id", "AAAAAAAAAAAA"])
def test_unknown_job_is_404(client: TestClient, job_id: str) -> None:
    assert client.patch(f"/api/jobs/{job_id}", json={"title": "x"}).status_code == 404


def test_rename_survives_a_restart(client: TestClient) -> None:
    _done()
    client.patch(f"/api/jobs/{JOB_ID}", json={"title": "Mine", "artist": "Me"})
    _jobs.clear()
    restore(cfg.JOBS_DIR)
    assert (_jobs[JOB_ID].display_title, _jobs[JOB_ID].user_artist) == ("Mine", "Me")


def test_rename_survives_a_lost_registry(client: TestClient) -> None:
    _done()
    client.patch(f"/api/jobs/{JOB_ID}", json={"title": "Mine", "artist": "Me"})
    _jobs.clear()
    (cfg.JOBS_DIR / "registry.json").unlink()
    restore(cfg.JOBS_DIR)
    assert (_jobs[JOB_ID].user_title, _jobs[JOB_ID].user_artist) == ("Mine", "Me")


def test_rename_survives_reanalysis(client: TestClient) -> None:
    job = _done()
    client.patch(f"/api/jobs/{JOB_ID}", json={"title": "Mine"})
    _set(job, title="newly detected", audio_tags={"artist": "Other"})
    _write_metadata(job, cfg.JOBS_DIR / JOB_ID)
    persist(cfg.JOBS_DIR)
    assert client.get(f"/api/jobs/{JOB_ID}").json()["title"] == "Mine"
    assert _metadata()["user_title"] == "Mine"


def test_display_artist_prefers_the_user_then_band_tag_identity() -> None:
    job = Job(id=JOB_ID, identity={"source": "tags", "title": "t", "artist": "Credit"})
    assert job.display_artist is None, "an identity from the tags alone is not shown"
    job.identity = {**job.identity, "source": "musicbrainz"}
    assert job.display_artist == "Credit"
    job.audio_tags = {"artist": "Tag"}
    assert job.display_artist == "Tag"
    job.artist = {"id": "Q1", "name": "Band", "englishName": ""}
    assert job.display_artist == "Band"
    job.user_artist = "Me"
    assert job.display_artist == "Me"


def test_display_artist_is_in_the_job_state(client: TestClient) -> None:
    _done(audio_tags={"artist": "Tagged Band"})
    assert client.get(f"/api/jobs/{JOB_ID}").json()["display_artist"] == "Tagged Band"
    state = client.patch(f"/api/jobs/{JOB_ID}", json={"artist": "Me"}).json()
    assert state["display_artist"] == "Me"


def test_a_rename_that_changes_nothing_writes_nothing(client: TestClient, monkeypatch) -> None:
    _done(user_title="Mine")
    writes: list = []
    monkeypatch.setattr(jobs_mod, "registry_persist", lambda *a: writes.append("registry"))
    monkeypatch.setattr(jobs_mod, "_write_metadata_fields", lambda *a: writes.append("metadata"))
    resp = client.patch(f"/api/jobs/{JOB_ID}", json={"title": "Mine", "artist": None})
    assert resp.status_code == 200
    assert resp.json()["user_title"] == "Mine"
    assert writes == []
