"""The lyrics version the user picked, and their removal: PUT and DELETE
.../lyrics, and the lookup a removal holds back.

Both are kept on the server with the song, so every device and every song
bundle shows the same lyrics. A browser's earlier choice is carried over with
?carry_over=true, which never overrides a decision the server already holds.
A version saved with ?picked=false is kept as lyrics found are, and yields to
the same decisions.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.api.jobs as jobs_mod
import app.core.config as cfg
from app.core.config import LYRICS_SAME_RECORDING_SEC
from app.core.models import Job
from app.core.registry import _jobs
from app.main import app
from app.pipeline.lyrics_lookup import LYRICS_REMOVED_FILE, LookupAnswer, keep_answer
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_bundle_api import _bundle, _write_stem

JOB_ID = "aaaaaaaaaaaa"
URL = f"/api/jobs/{JOB_ID}/lyrics"
CARRY = {"carry_over": "true"}
AUTOMATIC = {"picked": "false"}
DURATION = 50.0

FOUND_SYNCED = "[00:10.00] one\n[00:20.00] two\n[00:30.00] three\n[00:40.00] four"
PICK_SYNCED = "[00:11.00] uno\n[00:21.00] dos\n[00:31.00] tres"
PICK_USER_SYNCED = "[00:12.00]uno\n[00:22.00]dos\n[00:32.00]tres"
REMOVED = {"detail": "lyrics removed", "removed": True, "others": []}


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _version(lrclib_id: int | None, synced: str, **fields) -> dict:
    return {
        "source": "lrclib",
        "track": "detected title",
        "artist": "Band",
        "album": "Album",
        "duration": DURATION,
        "synced": synced,
        "plain": "",
        "instrumental": False,
        "lrclib_id": lrclib_id,
        **fields,
    }


FOUND = {"v": 1, **_version(7, FOUND_SYNCED), "others": [_version(9, "[00:01.00] nine")]}
PICK = _version(8, PICK_SYNCED)
EMBEDDED = {**_version(None, "", plain="from the file"), "source": "file"}


def _job(lyrics: dict | None = None, status: str = "done") -> Job:
    job = Job(
        id=JOB_ID,
        status=status,
        title="detected title",
        duration_sec=DURATION,
        audio_tags={"artist": "Band", "title": "detected title"},
    )
    _jobs[JOB_ID] = job
    _job_dir().mkdir(parents=True, exist_ok=True)
    if lyrics is not None:
        (_job_dir() / "lyrics.json").write_text(json.dumps(lyrics), encoding="utf-8")
        job.has_lyrics = True
    return job


def _job_dir():
    return cfg.JOBS_DIR / JOB_ID


def _on_disk() -> dict:
    return json.loads((_job_dir() / "lyrics.json").read_text(encoding="utf-8"))


def _removed() -> bool:
    return (_job_dir() / LYRICS_REMOVED_FILE).is_file()


def test_a_pick_is_kept_with_the_song_and_served_to_every_reader(client):
    job = _job(FOUND)
    resp = client.put(URL, json=PICK)
    assert resp.status_code == 200
    body = resp.json()
    assert (body["synced"], body["lrclib_id"], body["chosen"]) == (PICK_SYNCED, 8, True)
    assert [o["lrclib_id"] for o in body["others"]] == [7, 9]
    assert client.get(URL).json() == body
    assert _on_disk()["chosen"] is True
    assert job.has_lyrics is True


def test_picking_back_a_version_offered_drops_it_from_the_others(client):
    _job(FOUND)
    client.put(URL, json=PICK)
    body = client.put(URL, json=_version(9, "[00:01.00] nine")).json()
    assert body["lrclib_id"] == 9
    assert [o["lrclib_id"] for o in body["others"]] == [8, 7]


def test_a_pick_on_a_track_with_no_lyrics_offers_the_candidates(client):
    _job()
    candidates = {"v": 1, "searched_at": 1.0, "others": [_version(9, "[00:01.00] nine")]}
    (_job_dir() / "lyrics_candidates.json").write_text(json.dumps(candidates), encoding="utf-8")
    body = client.put(URL, json=PICK).json()
    assert [o["lrclib_id"] for o in body["others"]] == [9]


@pytest.mark.parametrize(
    ("duration", "timing"),
    [
        (DURATION + LYRICS_SAME_RECORDING_SEC, "exact"),
        (DURATION + LYRICS_SAME_RECORDING_SEC + 1, "unverified"),
        (0, "exact"),
    ],
)
def test_a_pick_says_whether_its_timing_is_the_tracks(client, duration, timing):
    _job(FOUND)
    body = client.put(URL, json={**PICK, "duration": duration}).json()
    assert body["timing"] == timing


def test_a_live_pick_leaves_the_old_versions_alignment_behind(client):
    _job({**FOUND, "offset_sec": 2.0})
    body = client.put(URL, json=PICK).json()
    assert "offset_sec" not in body


@pytest.mark.parametrize(
    "bad",
    [
        {**PICK, "source": "user"},
        {**PICK, "source": "elsewhere"},
        {**PICK, "synced": "", "plain": ""},
        {**PICK, "lrclib_id": -1},
        {k: v for k, v in PICK.items() if k != "duration"},
        [PICK],
    ],
)
def test_a_pick_that_is_not_a_version_is_refused(client, bad):
    _job(FOUND)
    assert client.put(URL, json=bad).status_code == 422
    assert _on_disk()["lrclib_id"] == 7


def test_a_pick_body_that_is_not_json_is_refused(client):
    _job(FOUND)
    resp = client.put(URL, content=b"{nope", headers={"content-type": "application/json"})
    assert resp.status_code == 422


def test_a_pick_body_too_large_is_refused(client):
    _job(FOUND)
    huge = {**PICK, "plain": "x" * (jobs_mod._CHOICE_BODY_MAX_BYTES + 1)}
    assert client.put(URL, json=huge).status_code == 413


def test_a_pick_waits_for_the_job_to_be_done(client):
    _job(FOUND, status="running")
    assert client.put(URL, json=PICK).status_code == 409
    assert client.delete(URL).status_code == 409
    assert _on_disk()["lrclib_id"] == 7


@pytest.mark.parametrize("method", ["put", "delete"])
def test_an_unknown_job_is_404(client, method):
    kwargs = {"json": PICK} if method == "put" else {}
    resp = getattr(client, method)("/api/jobs/bbbbbbbbbbbb/lyrics", **kwargs)
    assert resp.status_code == 404


def test_a_live_pick_never_overwrites_the_users_own_words(client):
    _job()
    client.put(f"{URL}/user-text", json={"text": "my\nwords"})
    resp = client.put(URL, json=PICK)
    assert resp.status_code == 409
    assert _on_disk()["source"] == "user"


def test_removing_lyrics_is_kept_and_served_as_removed(client):
    job = _job(FOUND)
    resp = client.delete(URL)
    assert (resp.status_code, resp.json()) == (404, REMOVED)
    assert not (_job_dir() / "lyrics.json").exists()
    assert _removed()
    assert job.has_lyrics is False
    get = client.get(URL)
    assert (get.status_code, get.json()) == (404, REMOVED)


def test_removing_the_users_own_words_drops_what_they_replaced_too(client):
    _job(FOUND)
    client.put(f"{URL}/user-text", json={"text": "my\nwords"})
    client.delete(URL)
    assert not (_job_dir() / "lyrics_original.json").exists()
    assert client.get(URL).json() == REMOVED


def test_removing_with_no_lyrics_still_records_it_and_repeats_harmlessly(client):
    _job()
    first, second = client.delete(URL), client.delete(URL)
    assert first.json() == second.json() == REMOVED
    assert _removed()


def test_a_pick_after_a_removal_brings_lyrics_back(client):
    _job(FOUND)
    client.delete(URL)
    resp = client.put(URL, json=PICK)
    assert resp.status_code == 200
    assert not _removed()


def test_the_users_own_words_after_a_removal_end_it(client):
    _job(FOUND)
    client.delete(URL)
    client.put(f"{URL}/user-text", json={"text": "my\nwords"})
    assert not _removed()
    assert client.get(URL).json()["source"] == "user"


def test_a_carried_over_pick_beats_lyrics_the_server_only_found(client):
    _job(FOUND)
    carried = {**PICK, "offset_sec": 1.5, "user_synced": PICK_USER_SYNCED}
    body = client.put(URL, params=CARRY, json=carried).json()
    assert (body["lrclib_id"], body["chosen"]) == (8, True)
    assert (body["offset_sec"], body["user_synced"]) == (1.5, PICK_USER_SYNCED)


def test_a_carried_over_timing_of_other_lines_is_dropped(client):
    _job(FOUND)
    body = client.put(URL, params=CARRY, json={**PICK, "user_synced": FOUND_SYNCED}).json()
    assert body["lrclib_id"] == 8
    assert "user_synced" not in body


@pytest.mark.parametrize(
    "server",
    [
        {**FOUND, "chosen": True},
        {**FOUND, "offset_sec": 2.0},
        {**FOUND, "source": "user", "lrclib_id": None},
    ],
)
def test_a_carry_over_never_overrides_a_decision_on_the_server(client, server):
    _job(server)
    before = _on_disk()
    put = client.put(URL, params=CARRY, json=PICK)
    delete = client.delete(URL, params=CARRY)
    assert (put.status_code, delete.status_code) == (200, 200)
    assert put.json()["lrclib_id"] == delete.json()["lrclib_id"] == server["lrclib_id"]
    assert _on_disk() == before
    assert not _removed()


def test_a_carry_over_is_idempotent(client):
    _job(FOUND)
    first = client.put(URL, params=CARRY, json=PICK).json()
    again = client.put(URL, params=CARRY, json={**PICK, "offset_sec": 3.0}).json()
    assert again == first


def test_a_carried_over_pick_leaves_a_removal_on_the_server(client):
    _job(FOUND)
    client.delete(URL)
    resp = client.put(URL, params=CARRY, json=PICK)
    assert (resp.status_code, resp.json()) == (404, REMOVED)
    assert not (_job_dir() / "lyrics.json").exists()


def test_a_carried_over_removal_beats_lyrics_the_server_only_found(client):
    _job(FOUND)
    resp = client.delete(URL, params=CARRY)
    assert (resp.status_code, resp.json()) == (404, REMOVED)
    assert _removed()


def test_an_automatic_save_is_kept_as_lyrics_found_not_as_a_pick(client):
    job = _job()
    resp = client.put(URL, params=AUTOMATIC, json=EMBEDDED)
    assert resp.status_code == 200
    assert (resp.json()["plain"], resp.json()["source"]) == ("from the file", "file")
    assert "chosen" not in resp.json()
    assert "chosen" not in _on_disk()
    assert job.has_lyrics is True


def test_a_lookups_answer_may_replace_an_automatic_save(client):
    job = _job()
    client.put(URL, params=AUTOMATIC, json=EMBEDDED)
    assert keep_answer(job, _job_dir(), LookupAnswer({**FOUND, "timing": "exact"}, [])) is True
    assert _on_disk()["lrclib_id"] == 7


@pytest.mark.parametrize("params", [{}, CARRY])
def test_a_pick_after_an_automatic_save_is_kept(client, params):
    _job()
    client.put(URL, params=AUTOMATIC, json=EMBEDDED)
    body = client.put(URL, params=params, json=PICK).json()
    assert (body["lrclib_id"], body["chosen"]) == (8, True)


@pytest.mark.parametrize("params", [AUTOMATIC, {**AUTOMATIC, **CARRY}])
@pytest.mark.parametrize(
    "server",
    [
        {**FOUND, "chosen": True},
        {**FOUND, "offset_sec": 2.0},
        {**FOUND, "source": "user", "lrclib_id": None},
    ],
)
def test_an_automatic_save_never_overrides_a_decision_on_the_server(client, params, server):
    _job(server)
    before = _on_disk()
    resp = client.put(URL, params=params, json=EMBEDDED)
    assert (resp.status_code, resp.json()["lrclib_id"]) == (200, server["lrclib_id"])
    assert _on_disk() == before


def test_an_automatic_save_leaves_a_removal(client):
    _job(FOUND)
    client.delete(URL)
    resp = client.put(URL, params=AUTOMATIC, json=EMBEDDED)
    assert (resp.status_code, resp.json()) == (404, REMOVED)
    assert _removed()


def _stub_lookup(monkeypatch, answer: LookupAnswer | None) -> list:
    calls = []

    def lookup(query, **_kwargs):
        calls.append(query)
        return answer

    monkeypatch.setattr(jobs_mod, "lookup_lyrics", lookup)
    return calls


def test_a_removal_holds_back_the_tabs_lookup(client, monkeypatch):
    _job(FOUND)
    client.delete(URL)
    calls = _stub_lookup(monkeypatch, LookupAnswer({**FOUND, "timing": "exact"}, []))
    resp = client.post(f"{URL}/lookup", json={})
    assert (resp.status_code, resp.json()) == (404, REMOVED)
    assert calls == []
    assert _removed()


def test_look_up_again_ends_a_removal_and_looks_up(client, monkeypatch):
    _job(FOUND)
    client.delete(URL)
    calls = _stub_lookup(monkeypatch, LookupAnswer({**FOUND, "timing": "exact"}, []))
    resp = client.post(f"{URL}/lookup", json={"again": True})
    assert resp.status_code == 200
    assert resp.json()["lrclib_id"] == 7
    assert len(calls) == 1
    assert not _removed()


def test_look_up_again_must_be_a_boolean(client):
    _job()
    assert client.post(f"{URL}/lookup", json={"again": "yes"}).status_code == 422


def test_a_bundle_carries_the_pick(client):
    skip_without_ffmpeg()
    _job(FOUND)
    _write_stem(cfg.JOBS_DIR, JOB_ID, "vocals")
    client.put(URL, params=CARRY, json={**PICK, "offset_sec": 1.5})
    bundled = json.loads(_bundle(client, JOB_ID).read("lyrics.json"))
    assert (bundled["synced"], bundled["offset_sec"], bundled["chosen"]) == (
        PICK_SYNCED,
        1.5,
        True,
    )
    assert "others" not in bundled


def test_a_bundle_of_removed_lyrics_has_none(client):
    skip_without_ffmpeg()
    _job(FOUND)
    _write_stem(cfg.JOBS_DIR, JOB_ID, "vocals")
    client.delete(URL)
    assert "lyrics.json" not in _bundle(client, JOB_ID).namelist()
