"""The user's own lyrics: PUT and DELETE .../lyrics/user-text.

Pasted, loaded or edited words stand in lyrics.json with source "user", so
every reader gets them, and what they replaced can be put back.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.core.config import LYRICS_NEW_LINE_SEC, LYRICS_USER_SYNCED_MAX_LINES
from app.core.models import Job
from app.core.registry import _jobs
from app.main import app
from app.pipeline.lyrics_lookup import (
    _TEXT_MAX_CHARS,
    LookupAnswer,
    clean_lyrics,
    copy_lyrics,
    keep_answer,
)
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_bundle_api import _bundle, _write_stem

JOB_ID = "aaaaaaaaaaaa"
URL = f"/api/jobs/{JOB_ID}/lyrics/user-text"
LYRICS_URL = f"/api/jobs/{JOB_ID}/lyrics"

FOUND_SYNCED = "[00:10.00] one\n[00:20.00] two\n[00:30.00] three\n[00:40.00] four"
FOUND_PLAIN = "one\ntwo\n\nthree\nfour"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _found(**fields) -> dict:
    return {
        "v": 1,
        "source": "lrclib",
        "track": "detected title",
        "artist": "Band",
        "album": "Album",
        "duration": 50.0,
        "synced": FOUND_SYNCED,
        "plain": FOUND_PLAIN,
        "instrumental": False,
        "lrclib_id": 7,
        **fields,
    }


def _job(lyrics: dict | None = None, status: str = "done") -> Job:
    job = Job(id=JOB_ID, status=status, title="detected title", duration_sec=50.0)
    _jobs[JOB_ID] = job
    job_dir = cfg.JOBS_DIR / JOB_ID
    job_dir.mkdir(parents=True, exist_ok=True)
    if lyrics is not None:
        (job_dir / "lyrics.json").write_text(json.dumps(lyrics), encoding="utf-8")
        job.has_lyrics = True
    return job


def _on_disk() -> dict:
    return json.loads((cfg.JOBS_DIR / JOB_ID / "lyrics.json").read_text(encoding="utf-8"))


def test_pasted_text_on_a_track_with_no_lyrics_is_saved_and_served(client):
    job = _job()
    resp = client.put(URL, json={"text": "first\r\n\r\nsecond\n"})
    assert resp.status_code == 200
    body = resp.json()
    assert (body["source"], body["synced"], body["plain"]) == ("user", "", "first\n\nsecond")
    assert body["has_original"] is False
    assert job.has_lyrics is True
    assert client.get(LYRICS_URL).json() == body
    assert "has_original" not in _on_disk()


def test_an_lrc_file_keeps_its_own_timing(client):
    _job()
    text = (
        "[ar:Band]\n[ti:Song]\n[offset:+500]\n\n"
        "[00:30.5]last\n"
        "[00:05.00][00:20:50]chorus\n"
        "[00:25.00]\n"
    )
    body = client.put(URL, json={"text": text}).json()
    assert body["synced"] == ("[00:05.00]chorus\n[00:20.50]chorus\n[00:25.00]\n[00:30.50]last")
    assert body["plain"] == "chorus\nchorus\nlast"
    assert body["offset_sec"] == -0.5
    assert "untimed_lines" not in body


def test_word_stamps_in_an_lrc_file_are_kept(client):
    _job()
    text = "[00:01.00]<00:01.00>hello <00:02.00>world<00:03.00>"
    assert client.put(URL, json={"text": text}).json()["synced"] == text


def test_supplied_lyrics_replace_the_found_ones_and_their_timing(client):
    _job(_found(offset_sec=1.5))
    body = client.put(URL, json={"text": "other words"}).json()
    assert (body["source"], body["synced"], body["lrclib_id"]) == ("user", "", None)
    assert "offset_sec" not in body
    assert body["has_original"] is True


def test_a_lookup_never_replaces_them(client):
    _job()
    client.put(URL, json={"text": "mine"})
    assert client.post(f"{LYRICS_URL}/lookup").json()["plain"] == "mine"


def test_a_lookup_answer_landing_after_the_paste_is_dropped(client):
    job = _job()
    client.put(URL, json={"text": "mine"})
    answer = LookupAnswer(lyrics=_found(others=[]), others=[])
    assert keep_answer(job, cfg.JOBS_DIR / JOB_ID, answer) is False
    assert (_on_disk()["source"], _on_disk()["plain"]) == ("user", "mine")


def test_a_lookup_answer_still_replaces_lyrics_that_are_not_the_users(client):
    job = _job(_found(plain="old words", synced=""))
    answer = LookupAnswer(lyrics=_found(others=[]), others=[])
    assert keep_answer(job, cfg.JOBS_DIR / JOB_ID, answer) is True
    assert _on_disk()["plain"] == FOUND_PLAIN


@pytest.mark.parametrize(
    ("tags", "synced"),
    [
        ("[total:180000]", "[00:01.00]a"),
        ("[ar:x][ti:y]", "[00:01.00]a"),
        ("[ar:x] [ti:y] [total:1]", "[00:01.00]a"),
    ],
)
def test_lrc_tag_lines_are_not_lyrics(client, tags, synced):
    _job()
    resp = client.put(URL, json={"text": f"{tags}\n{synced}"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["synced"] == synced


def test_a_bracketed_section_name_is_a_line_of_lyrics(client):
    _job()
    assert client.put(URL, json={"text": "[Chorus: Beyonce]\nwords"}).json()["plain"] == (
        "[Chorus: Beyonce]\nwords"
    )


def test_words_that_look_like_a_stamp_can_be_saved_then_timed(client):
    _job()
    client.put(URL, json={"text": "[1st verse]\nI <3 you"})
    resp = client.put(
        f"{LYRICS_URL}/user-synced",
        json={"synced": "[00:01.00]  [1st verse]\n[00:02.00] I <3 you"},
    )
    assert resp.status_code == 200, resp.text


def _edit(client, text: str) -> dict:
    resp = client.put(URL, json={"text": text, "keep_timing": True})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_an_edit_keeps_unchanged_lines_and_marks_the_changed_one(client):
    _job(_found())
    body = _edit(client, "one\nTWO\nthree\nfour")
    assert body["synced"] == "[00:10.00]one\n[00:20.00]TWO\n[00:30.00]three\n[00:40.00]four"
    assert body["untimed_lines"] == [1]
    assert body["plain"] == "one\nTWO\nthree\nfour"


def test_added_and_split_lines_are_spaced_between_their_neighbours(client):
    _job(_found())
    body = _edit(client, "one\nnew a\nnew b\ntwo\nthree\nfour")
    assert body["synced"].splitlines()[:4] == [
        "[00:10.00]one",
        "[00:13.33]new a",
        "[00:16.67]new b",
        "[00:20.00]two",
    ]
    assert body["untimed_lines"] == [1, 2]


def test_a_line_added_at_the_end_follows_the_last(client):
    _job(_found())
    body = _edit(client, "one\ntwo\nthree\nfour\nfive")
    assert body["synced"].splitlines()[-1] == f"[00:{40 + LYRICS_NEW_LINE_SEC:05.2f}]five"
    assert body["untimed_lines"] == [4]


def test_a_deleted_line_leaves_the_rest_timed(client):
    _job(_found())
    body = _edit(client, "one\nthree\nfour")
    assert body["synced"] == "[00:10.00]one\n[00:30.00]three\n[00:40.00]four"
    assert "untimed_lines" not in body


def test_a_whole_song_offset_stays_with_the_lyrics_own_timing(client):
    _job(_found(offset_sec=2.0))
    body = _edit(client, "one\ntwo\nthree\nFOUR")
    assert body["offset_sec"] == 2.0
    assert body["synced"].startswith("[00:10.00]one")


def test_the_users_timing_is_the_one_kept_with_its_word_stamps(client):
    user = "[00:11.00]<00:11.00>one<00:12.00>\n[00:21.00]two\n[00:31.00]three\n[00:41.00]four"
    _job(_found(offset_sec=2.0, user_synced=user))
    body = _edit(client, "one\ntwo\nthree\nFOUR")
    assert body["synced"].splitlines()[0] == "[00:11.00]<00:11.00>one<00:12.00>"
    assert body["synced"].splitlines()[3] == "[00:41.00]FOUR"
    assert "user_synced" not in body
    assert "offset_sec" not in body


def test_lines_all_as_they_were_change_nothing(client):
    user = "[00:11.00]one\n[00:21.00]two\n[00:31.00]three\n[00:41.00]four"
    _job(_found(user_synced=user))
    body = _edit(client, "one\n\ntwo\nthree\nfour")
    assert (body["source"], body["user_synced"]) == ("lrclib", user)
    assert not (cfg.JOBS_DIR / JOB_ID / "lyrics_original.json").exists()


def test_an_edit_of_every_line_keeps_each_start(client):
    _job(_found())
    body = _edit(client, "all\nnew\nwords\nhere")
    assert body["synced"] == "[00:10.00]all\n[00:20.00]new\n[00:30.00]words\n[00:40.00]here"
    assert body["untimed_lines"] == [0, 1, 2, 3]


def test_an_edit_of_a_one_line_song_keeps_its_start(client):
    _job(_found(synced="[00:10.00] one", plain="one"))
    body = _edit(client, "One")
    assert body["synced"] == "[00:10.00]One"
    assert body["untimed_lines"] == [0]


def test_an_edit_with_no_stamp_to_carry_has_no_timing(client):
    _job(_found())
    body = _edit(client, "all\nnew\nwords")
    assert body["synced"] == ""
    assert "untimed_lines" not in body


def test_an_edit_can_then_be_timed_in_the_sync_editor(client):
    _job(_found())
    _edit(client, "one\nTWO\nthree\nfour")
    timed = "[00:10.00]one\n[00:22.00]TWO\n[00:30.00]three\n[00:40.00]four"
    assert client.put(f"{LYRICS_URL}/user-synced", json={"synced": timed}).status_code == 200
    assert client.get(LYRICS_URL).json()["user_synced"] == timed


def test_untimed_lines_out_of_range_are_dropped_on_read():
    assert clean_lyrics(_found(untimed_lines=[1]))["untimed_lines"] == [1]
    assert "untimed_lines" not in clean_lyrics(_found(untimed_lines=[99]))
    assert "untimed_lines" not in clean_lyrics(_found(untimed_lines="1"))


def test_delete_restores_what_was_there_with_its_timing(client):
    user = "[00:11.00]one\n[00:21.00]two\n[00:31.00]three\n[00:41.00]four"
    _job(_found(offset_sec=1.0, user_synced=user))
    before = client.get(LYRICS_URL).json()
    client.put(URL, json={"text": "first edit"})
    client.put(URL, json={"text": "second edit"})
    resp = client.delete(URL)
    assert resp.status_code == 200
    assert resp.json() == before
    assert not (cfg.JOBS_DIR / JOB_ID / "lyrics_original.json").exists()


def test_delete_removes_lyrics_that_replaced_nothing(client):
    job = _job()
    client.put(URL, json={"text": "mine"})
    assert client.delete(URL).status_code == 404
    assert job.has_lyrics is False
    assert not (cfg.JOBS_DIR / JOB_ID / "lyrics.json").exists()


def test_delete_leaves_lyrics_that_are_not_the_users(client):
    _job(_found())
    assert client.delete(URL).json()["source"] == "lrclib"
    assert _on_disk()["source"] == "lrclib"


def test_a_re_split_takes_the_lyrics_to_go_back_to(client, tmp_path):
    _job(_found())
    client.put(URL, json={"text": "mine"})
    copy_lyrics(cfg.JOBS_DIR / JOB_ID, tmp_path)
    assert json.loads((tmp_path / "lyrics_original.json").read_text())["source"] == "lrclib"


def test_a_saved_band_leaves_the_lyrics_to_go_back_to(client):
    job = _job(_found())
    job.audio_tags = {"title": "detected title"}
    client.put(URL, json={"text": "mine"})
    band = {"id": "Q2", "name": "Other", "englishName": "Other"}
    client.patch(f"/api/jobs/{JOB_ID}", json={"band": band})
    assert client.get(LYRICS_URL).json()["has_original"] is True
    resp = client.delete(URL)
    assert resp.status_code == 200
    assert resp.json()["source"] == "lrclib"


def test_saving_over_unreadable_lyrics_keeps_the_original(client):
    _job(_found())
    client.put(URL, json={"text": "mine"})
    (cfg.JOBS_DIR / JOB_ID / "lyrics.json").write_text("{bad", encoding="utf-8")
    assert client.put(URL, json={"text": "again"}).status_code == 200
    assert client.delete(URL).json()["source"] == "lrclib"


def test_saving_with_no_lyrics_forgets_a_stale_original(client):
    _job(_found())
    client.put(URL, json={"text": "mine"})
    (cfg.JOBS_DIR / JOB_ID / "lyrics.json").unlink()
    assert client.put(URL, json={"text": "again"}).json()["has_original"] is False


def test_a_rename_keeps_the_users_lyrics(client):
    _job(_found())
    client.put(URL, json={"text": "mine"})
    client.patch(f"/api/jobs/{JOB_ID}", json={"title": "Another Song"})
    assert client.get(LYRICS_URL).json()["plain"] == "mine"


@pytest.mark.parametrize(
    ("text", "detail"),
    [
        ("  \n \n", "no lyrics"),
        ("[ar:Band]\n[ti:Song]", "no lyrics"),
        ("[00:01.00]\n[00:02.00]", "no lyrics"),
        ("hello\x00world", "not text"),
        ("caf�", "not text"),
        ("[00:01.00] timed\nnot timed", "Line 2 has no timestamp"),
        ("[00:01.00] timed\n[Chorus: Beyonce]", "Line 2 has no timestamp"),
        ("[00:75.00] bad", "Line 1 has an invalid timestamp"),
        ("[00:01.00] one [00:02.00] two", "Line 1 has a timestamp inside"),
        ("plain [01:23] words", "Line 1 has a timestamp inside"),
        ("[offset:+9999999]\n[00:01.00] far", "offset"),
        ("line\n" * (LYRICS_USER_SYNCED_MAX_LINES + 1), "more than"),
    ],
)
def test_unusable_text_is_refused_with_a_message(client, text, detail):
    _job(_found())
    resp = client.put(URL, json={"text": text})
    assert resp.status_code == 422, resp.text
    assert detail in resp.json()["detail"]
    assert _on_disk()["source"] == "lrclib"


def test_a_lone_surrogate_is_refused_as_not_text(client):
    _job(_found())
    resp = client.put(
        URL, content=b'{"text":"a\\ud800b"}', headers={"content-type": "application/json"}
    )
    assert resp.status_code == 422, resp.text
    assert "not text" in resp.json()["detail"]
    assert _on_disk()["source"] == "lrclib"


def test_too_many_characters_are_refused(client):
    _job()
    resp = client.put(URL, json={"text": "x" * (_TEXT_MAX_CHARS + 1)})
    assert resp.status_code == 413
    assert str(_TEXT_MAX_CHARS) in resp.json()["detail"]


def test_a_body_past_the_limit_is_refused(client):
    _job()
    assert client.put(URL, json={"text": "x" * (5 * _TEXT_MAX_CHARS)}).status_code == 413


@pytest.mark.parametrize(
    "body", [{}, {"text": None}, {"text": 5}, {"text": "ok", "keep_timing": "yes"}, ["text"]]
)
def test_a_body_of_the_wrong_shape_is_refused(client, body):
    _job()
    assert client.put(URL, json=body).status_code == 422


def test_an_unknown_job_is_not_found(client):
    assert client.put(URL, json={"text": "x"}).status_code == 404
    assert client.delete(URL).status_code == 404


def test_a_job_still_running_is_refused(client):
    _job(status="running")
    assert client.put(URL, json={"text": "x"}).status_code == 409


def test_a_bundle_carries_the_edit_then_the_original_again(client):
    skip_without_ffmpeg()
    _job(_found(offset_sec=1.0))
    _write_stem(cfg.JOBS_DIR, JOB_ID, "vocals")

    _edit(client, "one\nTWO\nthree\nfour")
    edited = json.loads(_bundle(client, JOB_ID).read("lyrics.json"))
    assert edited["synced"].splitlines()[1] == "[00:20.00]TWO"
    assert edited["plain"] == "one\nTWO\nthree\nfour"
    assert edited["source"] == "user"
    assert edited["offset_sec"] == 1.0
    assert edited["untimed_lines"] == [1]
    assert "others" not in edited

    client.delete(URL)
    restored = json.loads(_bundle(client, JOB_ID).read("lyrics.json"))
    assert (restored["synced"], restored["source"]) == (FOUND_SYNCED, "lrclib")


def test_a_bundle_carries_a_pasted_text_once_timed_as_synced(client):
    skip_without_ffmpeg()
    _job()
    _write_stem(cfg.JOBS_DIR, JOB_ID, "vocals")
    client.put(URL, json={"text": "first\nsecond"})
    timed = "[00:01.00]first\n[00:02.00]second"
    client.put(f"{LYRICS_URL}/user-synced", json={"synced": timed})
    bundled = json.loads(_bundle(client, JOB_ID).read("lyrics.json"))
    assert bundled["synced"] == timed


def test_a_bundle_carries_the_fitted_timing_instead_of_the_moved_copy(client):
    skip_without_ffmpeg()
    fitted = "[00:12.00]one\n[00:22.00]two\n[00:32.00]three\n[00:42.00]four"
    aligned = {"synced": fitted, "method": "whisper", "matched": 0.9}
    _job(_found(offset_sec=3.0, aligned={**aligned, "lines_matched": 4, "lines": 4, "at": 1.0}))
    _write_stem(cfg.JOBS_DIR, JOB_ID, "vocals")
    bundled = json.loads(_bundle(client, JOB_ID).read("lyrics.json"))
    assert bundled["synced"] == fitted
    assert "offset_sec" not in bundled
