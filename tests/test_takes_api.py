"""The takes routes (app/api/takes.py): create, upload parts, finish, edit,
delete and serve, against a scratch jobs dir and the router on its own app."""

from __future__ import annotations

import json

import numpy as np
import pytest
import soundfile as sf

import app.core.config as cfg
from app.api import takes as takes_api
from app.api import takes_common
from app.core.registry import _jobs
from app.core.takes_config import (
    AUDIO_PART_FILE,
    PARTS_FILE,
    TAKE_PART_MAX_BYTES,
    TAKE_RATE,
    TAKES_DIRNAME,
)
from tests._takes_helpers import (
    CAPTURE_RATE,
    JOB,
    OCTET,
    SONG_SEC,
    add_done_job,
    make_client,
    new_take,
    new_track,
    pcm,
    put_part,
    recorded_take,
    start_body,
)
from tests.ffmpeg_probe import skip_without_ffmpeg

BASE = f"/api/jobs/{JOB}"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def jobs_dir():
    return cfg.JOBS_DIR


@pytest.fixture
def job(jobs_dir):
    return add_done_job(jobs_dir)


@pytest.fixture
def client(job):
    return make_client()


@pytest.fixture
def track(client):
    return new_track(client)


@pytest.fixture
def needs_ffmpeg():
    skip_without_ffmpeg()


def _take_folder(jobs_dir, take_id):
    return jobs_dir / JOB / TAKES_DIRNAME / take_id


# --- preconditions -----------------------------------------------------------


def test_unknown_job_is_404(client):
    assert client.get("/api/jobs/aaaaaaaaaaaa/takes").status_code == 404


def test_job_not_done_is_404(client, job):
    job.status = "running"
    assert client.get(f"{BASE}/takes").status_code == 404


def test_trashed_job_is_404(client, job):
    job.trashed_at = 1.0
    assert client.get(f"{BASE}/takes").status_code == 404


def test_writes_during_a_library_move_are_503(client, track, monkeypatch):
    monkeypatch.setattr(takes_common, "is_relocating", lambda: True)
    r = client.post(f"{BASE}/takes", json=start_body(track))
    assert r.status_code == 503
    assert r.headers["retry-after"] == "2"


# --- create ------------------------------------------------------------------


def test_create_opens_a_take_listed_as_open(client, track):
    r = client.post(f"{BASE}/takes", json=start_body(track))
    assert r.status_code == 201
    body = r.json()
    assert body["track_id"] == track and body["label"] == "Take 1"
    listed = client.get(f"{BASE}/takes").json()
    assert listed["takes"] == []
    assert [o["id"] for o in listed["open"]] == [body["take_id"]]


def test_create_needs_a_known_track(client):
    assert client.post(f"{BASE}/takes", json=start_body("k00000000")).status_code == 422


def test_create_refuses_a_speed_other_than_normal(client, track):
    body = start_body(track)
    body["timeline"]["tempo"] = 0.8
    assert client.post(f"{BASE}/takes", json=body).status_code == 422


def test_create_refuses_unknown_fields(client, track):
    assert client.post(f"{BASE}/takes", json=start_body(track, extra=1)).status_code == 422


def test_create_stops_at_the_per_song_limit(client, track, monkeypatch):
    monkeypatch.setattr(takes_api, "TAKE_MAX_PER_JOB", 1)
    new_take(client, track)
    assert client.post(f"{BASE}/takes", json=start_body(track)).status_code == 409


# --- parts -------------------------------------------------------------------


def test_parts_append_in_sequence(client, track, jobs_dir):
    take_id = new_take(client, track)
    assert put_part(client, take_id, 0, pcm(100)).json()["bytes"] == 400
    r = put_part(client, take_id, 1, pcm(50))
    assert r.status_code == 200
    assert r.json() == {
        "take_id": take_id,
        "kind": "audio",
        "seq": 1,
        "bytes": 600,
        "duplicate": False,
    }
    assert (_take_folder(jobs_dir, take_id) / AUDIO_PART_FILE).stat().st_size == 600
    assert client.get(f"{BASE}/takes/{take_id}/parts").json() == {
        "audio": {"next_seq": 2, "bytes": 600},
        "finished": False,
    }


def test_resending_the_last_part_is_a_no_op(client, track, jobs_dir):
    take_id = new_take(client, track)
    put_part(client, take_id, 0, pcm(100))
    r = put_part(client, take_id, 0, pcm(100))
    assert r.status_code == 200 and r.json()["duplicate"] is True
    assert (_take_folder(jobs_dir, take_id) / AUDIO_PART_FILE).stat().st_size == 400


def test_a_gap_in_the_sequence_is_409(client, track):
    take_id = new_take(client, track)
    assert put_part(client, take_id, 1, pcm(100)).status_code == 409


def test_a_part_cut_short_by_a_crash_is_not_doubled_on_retry(client, track, jobs_dir):
    """The part reached the file but parts.json was not updated: the retry of
    the same seq must overwrite it, not append a second copy."""
    take_id = new_take(client, track)
    put_part(client, take_id, 0, pcm(100))
    folder = _take_folder(jobs_dir, take_id)
    with (folder / AUDIO_PART_FILE).open("ab") as fh:
        fh.write(pcm(50))
    assert put_part(client, take_id, 1, pcm(50)).json()["bytes"] == 600
    assert (folder / AUDIO_PART_FILE).stat().st_size == 600


def test_an_empty_or_ragged_part_is_422(client, track):
    take_id = new_take(client, track)
    assert put_part(client, take_id, 0, b"").status_code == 422
    assert put_part(client, take_id, 0, b"\0\0\0").status_code == 422


def test_a_part_over_the_cap_is_413(client, track):
    take_id = new_take(client, track)
    assert put_part(client, take_id, 0, b"\0" * (TAKE_PART_MAX_BYTES + 4)).status_code == 413


def test_a_take_longer_than_the_song_allows_is_413(client, track, monkeypatch):
    monkeypatch.setattr(takes_api, "TAKE_SLACK_SEC", 0)
    take_id = new_take(client, track)
    too_long = pcm(CAPTURE_RATE * SONG_SEC + 1)
    assert put_part(client, take_id, 0, too_long).status_code == 413


def test_camera_parts_wait_for_video_takes(client, track):
    take_id = new_take(client, track)
    r = client.put(f"{BASE}/takes/{take_id}/parts/camera?seq=0", content=b"\0" * 4, headers=OCTET)
    assert r.status_code == 404


# --- finish ------------------------------------------------------------------


@pytest.mark.usefixtures("needs_ffmpeg")
def test_finish_places_the_take_on_the_song_timeline(client, track, jobs_dir):
    impulse = CAPTURE_RATE // 4
    take_id = new_take(client, track, frame0=1.0, round_trip_ms=25.0)
    put_part(client, take_id, 0, pcm(impulse=impulse))
    r = client.post(f"{BASE}/takes/{take_id}/finish", json={"label": "Verse"})
    assert r.status_code == 200
    entry = r.json()
    assert entry["placement_sec"] == pytest.approx(0.975)
    assert entry["label"] == "Verse"
    data, rate = sf.read(str(_take_folder(jobs_dir, take_id) / "audio.wav"), always_2d=True)
    assert (rate, data.shape) == (TAKE_RATE, (TAKE_RATE * SONG_SEC, 2))
    expected = round((0.975 + impulse / CAPTURE_RATE) * TAKE_RATE)
    assert abs(int(np.argmax(np.abs(data[:, 0]))) - expected) <= 1


@pytest.mark.usefixtures("needs_ffmpeg")
def test_finish_lists_the_take_and_makes_it_active(client, track):
    entry = recorded_take(client, track)
    listed = client.get(f"{BASE}/takes").json()
    assert [t["id"] for t in listed["takes"]] == [entry["id"]]
    assert listed["open"] == []
    assert listed["tracks"][0]["active_take_id"] == entry["id"]


@pytest.mark.usefixtures("needs_ffmpeg")
def test_finish_twice_is_409(client, track):
    entry = recorded_take(client, track)
    assert client.post(f"{BASE}/takes/{entry['id']}/finish", json={}).status_code == 409


def test_finish_without_audio_is_422(client, track):
    take_id = new_take(client, track)
    assert client.post(f"{BASE}/takes/{take_id}/finish", json={}).status_code == 422


@pytest.mark.usefixtures("needs_ffmpeg")
def test_parts_after_finish_are_409(client, track):
    entry = recorded_take(client, track)
    assert put_part(client, entry["id"], 1, pcm(10)).status_code == 409


# --- edit --------------------------------------------------------------------


@pytest.mark.usefixtures("needs_ffmpeg")
def test_a_timing_change_re_renders_the_take(client, track, jobs_dir):
    entry = recorded_take(client, track, frame0=1.0, round_trip_ms=20.0)
    peaks = _take_folder(jobs_dir, entry["id"]) / "peaks.json"
    before = peaks.stat().st_mtime_ns
    r = client.patch(f"{BASE}/takes/{entry['id']}", json={"round_trip_ms": 30.0})
    assert r.status_code == 200
    assert r.json()["placement_sec"] == pytest.approx(0.97)
    r = client.patch(f"{BASE}/takes/{entry['id']}", json={"user_nudge_ms": 10.0})
    assert r.json()["placement_sec"] == pytest.approx(0.96)
    assert peaks.stat().st_mtime_ns != before


@pytest.mark.usefixtures("needs_ffmpeg")
def test_a_rename_does_not_re_render(client, track, jobs_dir):
    entry = recorded_take(client, track)
    wav = _take_folder(jobs_dir, entry["id"]) / "audio.wav"
    before = wav.stat().st_mtime_ns
    r = client.patch(f"{BASE}/takes/{entry['id']}", json={"label": "Chorus"})
    assert r.json()["label"] == "Chorus"
    assert wav.stat().st_mtime_ns == before


def test_editing_an_open_take_is_409(client, track):
    take_id = new_take(client, track)
    assert client.patch(f"{BASE}/takes/{take_id}", json={"label": "x"}).status_code == 409


@pytest.mark.usefixtures("needs_ffmpeg")
def test_an_empty_edit_is_422(client, track):
    entry = recorded_take(client, track)
    assert client.patch(f"{BASE}/takes/{entry['id']}", json={}).status_code == 422


# --- delete, serve -----------------------------------------------------------


def test_delete_an_open_take(client, track, jobs_dir):
    take_id = new_take(client, track)
    r = client.delete(f"{BASE}/takes/{take_id}")
    assert r.json() == {"take_id": take_id, "status": "deleted"}
    assert not _take_folder(jobs_dir, take_id).exists()


@pytest.mark.usefixtures("needs_ffmpeg")
def test_delete_a_finished_take_clears_the_active_take(client, track):
    entry = recorded_take(client, track)
    assert client.delete(f"{BASE}/takes/{entry['id']}").status_code == 200
    listed = client.get(f"{BASE}/takes").json()
    assert listed["takes"] == []
    assert listed["tracks"][0]["active_take_id"] is None


def test_delete_an_unknown_take_is_404(client):
    assert client.delete(f"{BASE}/takes/t00000000").status_code == 404


@pytest.mark.usefixtures("needs_ffmpeg")
def test_audio_is_served_with_ranges_and_peaks_as_json(client, track):
    entry = recorded_take(client, track)
    r = client.get(entry["url"], headers={"Range": "bytes=0-43"})
    assert r.status_code == 206 and r.content[:4] == b"RIFF"
    assert client.head(entry["url"]).status_code == 200
    peaks = client.get(entry["peaks_url"])
    assert peaks.status_code == 200 and list(peaks.json()) == [entry["id"]]


def test_audio_of_an_open_take_is_404(client, track):
    take_id = new_take(client, track)
    assert client.get(f"{BASE}/takes/{take_id}/audio.wav").status_code == 404


# --- restart -----------------------------------------------------------------


@pytest.mark.usefixtures("needs_ffmpeg")
def test_takes_survive_a_restart(client, track, jobs_dir):
    finished = recorded_take(client, track)
    open_id = new_take(client, track)
    put_part(client, open_id, 0, pcm(100))
    fresh = make_client()
    listed = fresh.get(f"{BASE}/takes").json()
    assert [t["id"] for t in listed["takes"]] == [finished["id"]]
    assert [o["id"] for o in listed["open"]] == [open_id]
    assert put_part(fresh, open_id, 1, pcm(100)).status_code == 200
    state = json.loads((_take_folder(jobs_dir, open_id) / PARTS_FILE).read_text(encoding="utf-8"))
    assert state["audio"] == {"next_seq": 2, "bytes": 800}
