from __future__ import annotations

import threading
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.models import Job
from app.core.registry import _jobs

PREVIEW = "/api/import/preview"
VIDEO_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa"
VIDEO_B = "https://www.youtube.com/watch?v=bbbbbbbbbbb"
PLAYLIST = "https://www.youtube.com/playlist?list=PLabc"
LIMIT_SEC = 1200


class _FakeYDL:
    """Stands in for YoutubeDL in both the link probe and the playlist expansion,
    so nothing here touches the network. ``infos`` maps a URL to what yt-dlp
    would return for it; a URL missing from it fails like a deleted video."""

    infos: dict[str, dict] = {}
    opts: list[dict] = []
    stall_url: str | None = None
    stalled_on: str | None = None
    release = threading.Event()

    def __init__(self, opts):
        type(self).opts.append(opts)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=False, process=True):
        if url == type(self).stall_url:
            type(self).stalled_on = threading.current_thread().name
            type(self).release.wait()
        if url not in type(self).infos:
            raise RuntimeError("Video unavailable")
        return type(self).infos[url]


def _video(title: str, duration: float | None = 200, **extra) -> dict:
    return {"title": title, "duration": duration, "uploader": "Channel", **extra}


def _track(video_id: str, title: str, duration: float | None = 200) -> dict:
    return {
        "url": f"https://www.youtube.com/watch?v={video_id}",
        "title": title,
        "duration": duration,
        "uploader": f"{title} Band",
    }


@pytest.fixture
def fake_ydl():
    _FakeYDL.infos = {}
    _FakeYDL.opts = []
    _FakeYDL.stall_url = None
    _FakeYDL.stalled_on = None
    _FakeYDL.release = threading.Event()
    with (
        patch("app.pipeline.download.YoutubeDL", _FakeYDL),
        patch("app.api.batch_import.get_max_duration_sec", lambda: LIMIT_SEC),
    ):
        yield _FakeYDL
    _FakeYDL.release.set()


@pytest.fixture
def client(fake_ydl):
    _jobs.clear()
    from app.main import app

    with TestClient(app) as c:
        yield c
    _jobs.clear()


def _preview(client, links=(), files=()) -> dict:
    res = client.post(PREVIEW, json={"links": list(links), "files": list(files)})
    assert res.status_code == 200, res.text
    return res.json()


def _in_library(source_url: str, **fields) -> Job:
    job = Job(id=f"lib{len(_jobs):09d}", source_url=source_url, **fields)
    _jobs[job.id] = job
    return job


# ── single links ─────────────────────────────────────────────────────────────


def test_a_link_reports_its_canonical_url_title_artist_and_length(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("Build My Life", 372, artist="Housefires")}

    [item] = _preview(client, ["https://youtu.be/aaaaaaaaaaa"])["items"]

    assert item == {
        "input": "https://youtu.be/aaaaaaaaaaa",
        "line": 1,
        "url": VIDEO_A,
        "title": "Build My Life",
        "artist": "Housefires",
        "duration_sec": 372,
        "status": "ok",
        "existing_job_id": None,
        "replaces": None,
        "playlist": None,
    }


def test_the_uploader_stands_in_when_there_is_no_artist(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("Song")}
    [item] = _preview(client, [VIDEO_A])["items"]
    assert item["artist"] == "Channel"


def test_text_and_unsupported_hosts_are_not_links(client):
    items = _preview(client, ["setlist for sunday", "https://open.spotify.com/track/x"])["items"]
    assert [(i["status"], i["url"]) for i in items] == [("not_a_link", None)] * 2


def test_a_link_that_cannot_be_read_is_unavailable_not_an_error(client):
    [item] = _preview(client, [VIDEO_A])["items"]
    assert (item["status"], item["url"], item["title"]) == ("unavailable", VIDEO_A, None)


def test_a_link_over_the_limit_is_too_long(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("Archive", LIMIT_SEC + 1), VIDEO_B: _video("Song", None)}
    items = _preview(client, [VIDEO_A, VIDEO_B])["items"]
    assert [i["status"] for i in items] == ["too_long", "ok"]


def test_blank_lines_are_ignored_and_order_is_kept(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("A"), VIDEO_B: _video("B")}
    items = _preview(client, [VIDEO_B, "  ", "nope", VIDEO_A])["items"]
    assert [(i["input"], i["line"]) for i in items] == [(VIDEO_B, 1), ("nope", 3), (VIDEO_A, 4)]


def test_a_link_that_takes_too_long_to_read_is_unavailable(client, fake_ydl):
    fake_ydl.infos = {VIDEO_B: _video("B")}
    fake_ydl.stall_url = VIDEO_A
    with patch("app.api.batch_import.TIMEOUT_BATCH_PROBE", 0.2):
        try:
            items = _preview(client, [VIDEO_A, VIDEO_B])["items"]
        finally:
            fake_ydl.release.set()
    assert [i["status"] for i in items] == ["unavailable", "ok"]


def test_a_stuck_read_holds_a_probe_thread_not_a_shared_one(client, fake_ydl):
    from app.api.batch_import import PROBE_THREAD_PREFIX

    fake_ydl.stall_url = VIDEO_A
    with patch("app.api.batch_import.TIMEOUT_BATCH_PROBE", 0.2):
        try:
            _preview(client, [VIDEO_A])
        finally:
            fake_ydl.release.set()
    assert fake_ydl.stalled_on.startswith(PROBE_THREAD_PREFIX)


def test_the_same_song_twice_is_listed_once(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("A")}
    items = _preview(client, [VIDEO_A, "https://youtu.be/aaaaaaaaaaa"])["items"]
    assert [i["input"] for i in items] == [VIDEO_A]


# ── library duplicates ───────────────────────────────────────────────────────


def test_a_song_the_library_holds_is_in_library_with_its_job(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("A"), VIDEO_B: _video("B")}
    held = _in_library(VIDEO_A)
    _in_library(VIDEO_B, status="error")

    items = _preview(client, [VIDEO_A, VIDEO_B])["items"]

    assert [(i["status"], i["existing_job_id"]) for i in items] == [
        ("in_library", held.id),
        ("ok", None),
    ]


def test_a_song_whose_files_are_gone_is_queued_to_replace_that_copy(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("A")}
    gone = _in_library(VIDEO_A, status="done")

    body = _preview(client, [VIDEO_A], ["Song.mp3"])
    [item] = body["items"]

    assert (item["status"], item["existing_job_id"], item["replaces"]) == ("ok", None, gone.id)
    assert body["files"][0]["replaces"] is None


def test_a_file_whose_copy_is_gone_is_queued_to_replace_it(client):
    gone = _in_library("local:Song", status="done")
    [file] = _preview(client, files=["Song.mp3"])["files"]
    assert (file["status"], file["replaces"]) == ("ok", gone.id)


def test_too_long_wins_over_in_library_but_keeps_the_job(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("A", LIMIT_SEC + 1)}
    held = _in_library(VIDEO_A)
    [item] = _preview(client, [VIDEO_A])["items"]
    assert (item["status"], item["existing_job_id"]) == ("too_long", held.id)


def test_a_file_already_uploaded_is_in_library(client):
    held = _in_library("local:01 Goodness of God")
    files = _preview(client, files=["01 Goodness of God.flac", "02 Build My Life.mp3"])["files"]
    assert files == [
        {
            "name": "01 Goodness of God.flac",
            "status": "in_library",
            "existing_job_id": held.id,
            "replaces": None,
        },
        {"name": "02 Build My Life.mp3", "status": "ok", "existing_job_id": None, "replaces": None},
    ]


# ── playlists ────────────────────────────────────────────────────────────────


def test_a_playlist_line_expands_to_its_tracks(client, fake_ydl):
    fake_ydl.infos = {
        PLAYLIST: {
            "title": "Worship Nights",
            "entries": [
                _track("ccccccccccc", "Holy Forever"),
                {"url": "", "title": "[Deleted video]"},
                _track("ddddddddddd", "Same God", LIMIT_SEC + 1),
            ],
        }
    }
    _in_library("https://www.youtube.com/watch?v=ccccccccccc")

    body = _preview(client, [PLAYLIST])

    assert [
        (i["title"], i["artist"], i["status"], i["playlist"]["index"]) for i in body["items"]
    ] == [
        ("Holy Forever", "Holy Forever Band", "in_library", 1),
        ("Same God", "Same God Band", "too_long", 2),
    ]
    assert {i["input"] for i in body["items"]} == {PLAYLIST}
    assert body["playlists"] == [
        {
            "input": PLAYLIST,
            "line": 1,
            "url": PLAYLIST,
            "title": "Worship Nights",
            "found": 2,
            "unavailable": 1,
            "truncated": False,
        }
    ]


def test_a_playlist_that_cannot_be_read_is_one_unavailable_item(client):
    body = _preview(client, [PLAYLIST])
    assert [(i["status"], i["playlist"]) for i in body["items"]] == [("unavailable", None)]
    assert body["playlists"] == []


def test_a_pasted_link_also_in_a_playlist_is_listed_and_counted_once(client, fake_ydl):
    fake_ydl.infos = {
        VIDEO_A: _video("A"),
        PLAYLIST: {
            "title": "P",
            "entries": [_track("aaaaaaaaaaa", "A"), _track("ccccccccccc", "C")],
        },
    }
    body = _preview(client, [VIDEO_A, PLAYLIST])
    assert [(i["title"], i["line"]) for i in body["items"]] == [("A", 1), ("C", 2)]
    assert body["playlists"][0]["found"] == 1


# ── the request ──────────────────────────────────────────────────────────────


def test_preview_creates_nothing_and_reports_the_limits(client, fake_ydl):
    fake_ydl.infos = {VIDEO_A: _video("A")}
    body = _preview(client, [VIDEO_A], ["a.mp3"])
    assert _jobs == {}
    assert body["max_duration_sec"] == LIMIT_SEC
    assert body["capacity_left"]["links"] > 0
    assert body["capacity_left"]["files"] > 0


def test_too_many_links_is_refused(client):
    from app.api.batch_import import MAX_BATCH_LINKS

    res = client.post(PREVIEW, json={"links": [VIDEO_A] * (MAX_BATCH_LINKS + 1)})
    assert res.status_code == 422


def test_blank_lines_do_not_count_against_the_cap(client):
    from app.api.batch_import import MAX_BATCH_LINKS

    res = client.post(PREVIEW, json={"links": [VIDEO_A, *[""] * MAX_BATCH_LINKS]})
    assert res.status_code == 200


def test_the_link_probe_stays_on_the_supported_extractors(client, fake_ydl):
    from app.pipeline.download import _ALLOWED_EXTRACTORS

    fake_ydl.infos = {VIDEO_A: _video("A")}
    _preview(client, [VIDEO_A])
    [opts] = fake_ydl.opts
    assert opts["allowed_extractors"] == _ALLOWED_EXTRACTORS
    assert opts["noplaylist"] is True


def test_the_probe_refuses_a_host_it_does_not_support():
    from app.pipeline.download import InvalidYouTubeURL, probe_info

    with pytest.raises(InvalidYouTubeURL):
        probe_info("https://example.com/song")
