"""Renaming a song: the user's title and artist win over the detected ones.

They are kept beside the detected values (user_title, user_artist), so the
pipeline and the tag backfill can rewrite what they detect without undoing the
rename, and null puts the detected value back.
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import jobs as jobs_mod
from app.core.config import SONG_NAME_MAX_CHARS
from app.core.models import Job, _set, clean_artist
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


BAND = {"id": "Q123", "name": "Picked", "englishName": "Picked Band"}
FOUND_BAND = {"id": "Q9", "name": "Found", "englishName": "Found"}


def test_a_saved_band_wins_and_is_kept_beside_the_found_one(client: TestClient) -> None:
    job = _done(artist=FOUND_BAND)
    state = client.patch(f"/api/jobs/{JOB_ID}", json={"band": BAND}).json()
    assert state["user_band"] == BAND
    assert state["artist"] == BAND
    assert state["display_artist"] == "Picked"
    assert job.artist == FOUND_BAND
    assert _metadata()["user_band"] == BAND
    assert client.get(f"/api/jobs/{JOB_ID}").json()["user_band"] == BAND
    assert client.get("/api/jobs").json()[0]["artist"] == BAND


def test_clearing_a_band_brings_the_found_one_back(client: TestClient) -> None:
    _done(artist=FOUND_BAND, user_band=BAND)
    state = client.patch(f"/api/jobs/{JOB_ID}", json={"band": None}).json()
    assert state["user_band"] is None
    assert state["artist"] == FOUND_BAND
    assert _metadata()["user_band"] is None


def test_a_saved_band_forgets_nothing_else(client: TestClient) -> None:
    identity = {"title": "Song", "artist": "Band", "source": "acoustid"}
    work = {"id": "Q5", "kind": "film", "name": "Film", "englishName": "Film"}
    job = _done(identity=identity, work=work)
    job_dir = cfg.JOBS_DIR / JOB_ID
    (job_dir / "lyrics_candidates.json").write_text("{}", encoding="utf-8")
    client.patch(f"/api/jobs/{JOB_ID}", json={"band": BAND})
    assert job.identity is not None
    assert job.work is not None
    assert (job_dir / "lyrics_candidates.json").exists()


def test_a_rename_of_the_artist_keeps_the_saved_band(client: TestClient) -> None:
    job = _done(artist=FOUND_BAND, user_band=BAND)
    state = client.patch(f"/api/jobs/{JOB_ID}", json={"artist": "Typed"}).json()
    assert job.artist is None
    assert state["user_band"] == BAND
    assert state["display_artist"] == "Typed"


def test_a_saved_band_survives_a_restart_and_a_lost_registry(client: TestClient) -> None:
    _done()
    client.patch(f"/api/jobs/{JOB_ID}", json={"band": BAND})
    persist(cfg.JOBS_DIR)
    _jobs.clear()
    restore(cfg.JOBS_DIR)
    assert _jobs[JOB_ID].user_band == BAND

    (cfg.JOBS_DIR / "registry.json").unlink()
    _jobs.clear()
    restore(cfg.JOBS_DIR)
    assert _jobs[JOB_ID].user_band == BAND


def test_a_later_metadata_write_keeps_the_band(client: TestClient) -> None:
    job = _done()
    client.patch(f"/api/jobs/{JOB_ID}", json={"band": BAND})
    _write_metadata(job, cfg.JOBS_DIR / JOB_ID)
    assert _metadata()["user_band"] == BAND


@pytest.mark.parametrize(
    "band",
    [
        {"id": "123", "name": "x"},
        {"id": "Q", "name": "x"},
        {"id": "Q12x", "name": "x"},
        {"id": "Q١٢٣", "name": "x"},
        {"id": "Q1\n", "name": "x"},
        {"id": "Q1234567890123", "name": "x"},
        {"id": "Q1"},
        {"id": "Q1", "name": "  ", "englishName": ""},
        {"id": "Q1", "name": "x" * 301},
        {"id": "Q1", "name": 5},
        "Q1",
    ],
)
def test_an_invalid_band_is_refused(client: TestClient, band) -> None:
    job = _done(user_band=BAND)
    assert client.patch(f"/api/jobs/{JOB_ID}", json={"band": band}).status_code == 422
    assert job.user_band == BAND


def test_a_saved_id_of_other_digits_is_not_read_back() -> None:
    assert clean_artist({"id": "Q١٢٣", "name": "x"}) is None


OTHER_BAND = {"id": "Q2", "name": "Other", "englishName": "Other"}
QUEEN_BAND = {"id": "Q1", "name": "Queen", "englishName": "Queen"}
SONG_TAGS = {"title": "Song"}


def _version(artist: str = "Queen", track: str = "Song") -> dict:
    return {
        "v": 1,
        "source": "lrclib",
        "track": track,
        "artist": artist,
        "album": "",
        "duration": 50.0,
        "synced": "",
        "plain": "words",
        "instrumental": False,
        "lrclib_id": 7,
    }


def _with_lyrics(artist: str = "Queen", **fields) -> Job:
    job = _done(**fields)
    (cfg.JOBS_DIR / JOB_ID / "lyrics.json").write_text(
        json.dumps({**_version(artist), "others": []}), encoding="utf-8"
    )
    job.has_lyrics = True
    return job


def _lyrics_kept(client: TestClient, job: Job) -> bool:
    found = client.get(f"/api/jobs/{JOB_ID}/lyrics").status_code == 200
    assert (cfg.JOBS_DIR / JOB_ID / "lyrics.json").exists() is found
    assert job.has_lyrics is found
    return found


@pytest.mark.parametrize(
    "fields",
    [
        {"audio_tags": SONG_TAGS},
        {"audio_tags": SONG_TAGS, "artist": QUEEN_BAND},
        {"user_title": "Song"},
        {"user_title": "Song", "artist": QUEEN_BAND},
    ],
)
def test_saving_or_clearing_a_band_keeps_found_lyrics(client: TestClient, fields: dict) -> None:
    job = _with_lyrics(**fields)
    assert client.patch(f"/api/jobs/{JOB_ID}", json={"band": OTHER_BAND}).status_code == 200
    assert _lyrics_kept(client, job)
    assert client.patch(f"/api/jobs/{JOB_ID}", json={"band": None}).status_code == 200
    assert _lyrics_kept(client, job)


@pytest.mark.parametrize("found", [None, QUEEN_BAND])
def test_lyrics_found_under_the_saved_band_stand_while_it_is_saved(
    client: TestClient, found: dict | None
) -> None:
    job = _with_lyrics(artist="Other", audio_tags=SONG_TAGS, user_band=OTHER_BAND)
    job.artist = found
    assert _lyrics_kept(client, job)


def test_lyrics_found_under_the_saved_band_outlast_it_with_no_band_found(
    client: TestClient,
) -> None:
    job = _with_lyrics(artist="Other", audio_tags=SONG_TAGS, user_band=OTHER_BAND)
    client.patch(f"/api/jobs/{JOB_ID}", json={"band": None})
    assert _lyrics_kept(client, job)


def test_a_saved_band_keeps_the_versions_on_offer(client: TestClient) -> None:
    _done(audio_tags=SONG_TAGS)
    (cfg.JOBS_DIR / JOB_ID / "lyrics_candidates.json").write_text(
        json.dumps({"v": 1, "searched_at": time.time(), "others": [_version()]}),
        encoding="utf-8",
    )
    client.patch(f"/api/jobs/{JOB_ID}", json={"band": OTHER_BAND})
    others = client.get(f"/api/jobs/{JOB_ID}/lyrics").json()["others"]
    assert [o["artist"] for o in others] == ["Queen"]


@pytest.mark.parametrize("rename", [{"artist": "Someone Else"}, {"title": "Another Song"}])
def test_a_rename_still_drops_lyrics_the_new_names_disown(client: TestClient, rename: dict) -> None:
    job = _with_lyrics(audio_tags=SONG_TAGS, user_band=OTHER_BAND)
    assert client.patch(f"/api/jobs/{JOB_ID}", json=rename).status_code == 200
    assert not _lyrics_kept(client, job)
