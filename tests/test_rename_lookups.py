"""A renamed song is looked up by its new names.

The identity, band, work and lyrics lookups search by the display title and
artist (Job.lookup_tags), identify a renamed song by name rather than by its
AcoustID fingerprint, and a rename forgets what the old names found.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import jobs as jobs_mod
from app.core.models import Job
from app.core.registry import _jobs, register
from app.main import app
from app.pipeline import identify as identify_mod
from app.pipeline import lyrics_lookup as lyrics_mod
from app.pipeline.lyrics_lookup import build_query, candidates_path, lyrics_path, write_candidates
from app.pipeline.runner import _write_metadata

JOB_ID = "aaaaaaaaaaaa"
IDENTITY = {"source": "acoustid", "title": "Old Song", "artist": "Old Band"}
BAND = {"id": "Q1", "name": "Old Band", "englishName": "Old Band"}
WORK = {"id": "Q2", "kind": "musical", "name": "Old Show", "englishName": "Old Show"}
TAGS = {"artist": "Old Band", "title": "Old Song", "album": "Old Album"}
OLD_LYRICS = {
    "v": 1,
    "source": "lrclib",
    "track": "Old Song",
    "artist": "Old Band",
    "duration": 200.0,
    "synced": "[00:01.00]old words",
    "plain": "old words",
    "instrumental": False,
    "timing": "exact",
    "others": [],
    "lrclib_id": 3,
}


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _done(**fields) -> Job:
    fields = {"identity": IDENTITY, "artist": BAND, "audio_tags": TAGS, **fields}
    job = Job(id=JOB_ID, status="done", title="Old Band - Old Song (video)", **fields)
    register(job)
    job_dir = cfg.JOBS_DIR / JOB_ID
    (job_dir / "stems").mkdir(parents=True, exist_ok=True)
    _write_metadata(job, job_dir)
    return job


def _write_lyrics(entry: dict) -> None:
    lyrics_path(cfg.JOBS_DIR / JOB_ID).write_text(json.dumps(entry), encoding="utf-8")


def _metadata() -> dict:
    return json.loads((cfg.JOBS_DIR / JOB_ID / "metadata.json").read_text(encoding="utf-8"))


def test_lookup_tags_put_the_users_names_over_the_detected() -> None:
    job = Job(id=JOB_ID, audio_tags=TAGS)
    assert job.lookup_tags(TAGS) is TAGS
    assert job.lookup_tags(None) is None
    job.user_title = "New Song"
    assert job.lookup_tags(TAGS) == {**TAGS, "title": "New Song"}
    job.user_artist = "New Band"
    assert job.lookup_tags(TAGS) == {**TAGS, "title": "New Song", "artist": "New Band"}
    assert TAGS["title"] == "Old Song", "the job's own tags are left alone"


def test_no_tags_never_means_the_jobs_own() -> None:
    job = Job(id=JOB_ID, audio_tags=TAGS, user_title="New Song", user_artist="New Band")
    assert job.lookup_tags(None) == {"title": "New Song", "artist": "New Band"}


def test_a_renamed_title_borrows_the_band_when_no_tag_names_an_artist() -> None:
    job = Job(id=JOB_ID, artist=BAND, user_title="New Song")
    assert job.lookup_tags(None) == {"title": "New Song", "artist": "Old Band"}


def test_lyrics_are_looked_up_by_the_new_names(client: TestClient) -> None:
    _done()
    client.patch(f"/api/jobs/{JOB_ID}", json={"title": "New Song", "artist": "New Band"})
    query = build_query(_jobs[JOB_ID])
    assert (query.track, query.artist, query.album) == ("New Song", "New Band", "Old Album")


def test_a_renamed_title_alone_is_the_lyrics_fallback_title() -> None:
    job = Job(id=JOB_ID, title="Old Band - Old Song (video)", artist=BAND, user_title="New Song")
    query = build_query(job)
    assert (query.track, query.artist) == ("New Song", "Old Band")


def test_a_renamed_song_is_identified_by_name_not_fingerprint() -> None:
    job = Job(id=JOB_ID, title="Old title", audio_tags=TAGS, user_artist="New Band")
    asked: dict = {}

    def fake_identify(**kwargs):
        asked.update(kwargs)
        return None

    with (
        patch.object(identify_mod, "get_acoustid_api_key", return_value="KEY"),
        patch.object(identify_mod, "identify", fake_identify),
    ):
        identify_mod.identify_and_find_band(job, [], tags=TAGS, want_band=False)
        assert identify_mod.fingerprint_key(Job(id=JOB_ID)) == "KEY"
    assert asked["api_key"] is None
    assert asked["tags"] == {**TAGS, "artist": "New Band"}
    assert asked["title"] == "Old title"


def test_the_pipeline_identifies_a_renamed_song_by_name() -> None:
    job = Job(id=JOB_ID, title="Old title", audio_tags=TAGS, user_title="New Song")
    asked: dict = {}

    def fake_identify(**kwargs):
        asked.update(kwargs)
        return None

    with (
        patch.object(identify_mod, "get_acoustid_api_key", return_value="KEY"),
        patch.object(identify_mod, "identify", fake_identify),
        patch.object(identify_mod, "find_band_for", return_value=None),
        patch.object(identify_mod, "find_work", return_value=None),
    ):
        lookup = identify_mod.IdentifyLookup.start(job, [cfg.JOBS_DIR / "source.wav"])
        lookup.finish(job, timeout=5)
    assert asked["api_key"] is None
    assert asked["audio"] == []
    assert (asked["tags"]["title"], asked["title"]) == ("New Song", "New Song")


def test_renaming_forgets_what_the_old_names_found(client: TestClient) -> None:
    job = _done(work=WORK)
    job_dir = cfg.JOBS_DIR / JOB_ID
    write_candidates(job, job_dir, [])
    _write_lyrics(OLD_LYRICS)

    state = client.patch(f"/api/jobs/{JOB_ID}", json={"artist": "New Band"}).json()

    assert (state["identity"], state["artist"], state["work"]) == (None, None, None)
    assert state["has_lyrics"] is False
    assert not lyrics_path(job_dir).exists()
    assert not candidates_path(job_dir).exists()
    meta = _metadata()
    assert (meta["identity"], meta["artist"], meta["work"]) == (None, None, None)


def test_renaming_the_title_keeps_the_band(client: TestClient) -> None:
    _done(work=WORK)
    state = client.patch(f"/api/jobs/{JOB_ID}", json={"title": "New Song"}).json()
    assert (state["identity"], state["work"]) == (None, None)
    assert state["artist"] == BAND


def test_lyrics_that_still_fit_or_were_worked_on_are_kept(client: TestClient) -> None:
    _done(has_lyrics=True)
    _write_lyrics(OLD_LYRICS)
    client.patch(f"/api/jobs/{JOB_ID}", json={"title": "old song"})
    assert lyrics_path(cfg.JOBS_DIR / JOB_ID).exists(), "the same song by its new casing"

    _write_lyrics({**OLD_LYRICS, "offset_sec": 1.5})
    state = client.patch(f"/api/jobs/{JOB_ID}", json={"title": "Another Song"}).json()
    assert lyrics_path(cfg.JOBS_DIR / JOB_ID).exists()
    assert state["has_lyrics"] is True


def test_sending_the_same_names_forgets_nothing(client: TestClient) -> None:
    job = _done(user_title="Mine", work=WORK)
    write_candidates(job, cfg.JOBS_DIR / JOB_ID, [])
    state = client.patch(f"/api/jobs/{JOB_ID}", json={"title": "Mine"}).json()
    assert (state["identity"], state["artist"], state["work"]) == (IDENTITY, BAND, WORK)
    assert candidates_path(cfg.JOBS_DIR / JOB_ID).exists()


def test_the_users_names_outrank_an_identity_crediting_someone_else() -> None:
    identity = {
        "source": "musicbrainz",
        "title": "Hosanna",
        "artist": "Hillsong en Français",
        "artist_mbids": ["95eabb26-6bda-4df3-a3fa-f2ae62d11de5"],
        "title_aliases": ["Hosanna (Live)"],
        "album": "Ce Nom Si Merveilleux",
    }
    job = Job(id=JOB_ID, identity=identity, user_title="Hosanna", user_artist="Hillsong Worship")
    query = build_query(job)
    assert (query.track, query.artist, query.album) == ("Hosanna", "Hillsong Worship", "")
    assert (query.artist_ids, query.track_aliases) == ((), ())


def test_a_renamed_artist_finds_the_band_by_name() -> None:
    identity = {"source": "musicbrainz", "title": "Hosanna", "artist_mbids": ["x"]}
    job = Job(id=JOB_ID, identity=identity, user_artist="Hillsong Worship")
    asked: list = []

    def fake_band(identity, artist_tag, **_kwargs):
        asked.append((identity, artist_tag))

    with patch.object(identify_mod, "find_band_for", fake_band):
        identify_mod.identify_and_find_band(job, [], tags=None, want_band=True)
    assert asked == [(None, "Hillsong Worship")]
    assert identify_mod.band_identity(Job(id=JOB_ID), identity) is identity


def _rename_meanwhile(job: Job, answer):
    def lookup(*_args, **_kwargs):
        job.user_artist = "New Band"
        return answer

    return lookup


def test_the_pipeline_drops_an_identity_found_by_the_old_names() -> None:
    job = Job(id=JOB_ID, title="Old title", audio_tags=TAGS)
    with (
        patch.object(identify_mod, "get_acoustid_api_key", return_value=None),
        patch.object(identify_mod, "identify", _rename_meanwhile(job, IDENTITY)),
        patch.object(identify_mod, "find_band_for", return_value=BAND),
        patch.object(identify_mod, "find_work", return_value=None),
    ):
        lookup = identify_mod.IdentifyLookup.start(job, [])
        lookup.finish(job, timeout=5)
    assert (job.identity, job.artist) == (None, None)


def test_the_pipeline_drops_lyrics_found_by_the_old_names() -> None:
    job = Job(id=JOB_ID, title="Old title", audio_tags=TAGS)
    job_dir = cfg.JOBS_DIR / JOB_ID
    job_dir.mkdir(parents=True, exist_ok=True)
    kept: list = []
    with (
        patch.object(lyrics_mod, "find_lyrics", _rename_meanwhile(job, object())),
        patch.object(lyrics_mod, "keep_answer", lambda *args: kept.append(args)),
    ):
        lookup = lyrics_mod.LyricsLookup.start(job, job_dir)
        lookup.finish(job, job_dir, 5)
    assert kept == []


def test_the_backfill_drops_what_the_old_names_found(client: TestClient) -> None:
    job = _done(identity=None, artist=None)
    with (
        patch.object(jobs_mod, "identify_and_find_band", _rename_meanwhile(job, (IDENTITY, BAND))),
        patch.object(jobs_mod, "find_work", return_value=None),
        patch.object(jobs_mod, "find_lyrics", return_value=None),
    ):
        answer = client.post(f"/api/jobs/{JOB_ID}/audio-tags").json()
    assert (answer["identity"], answer["artist"]) == (None, None)
    assert (job.identity, job.artist) == (None, None)
