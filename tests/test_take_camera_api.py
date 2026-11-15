"""Filmed takes through the routes (#102): video tracks and "I play", the
camera upload and its finish, the camera file, and the trim and camera
offset edits. Scratch jobs dir, real ffmpeg for the camera clip."""

from __future__ import annotations

import pytest

import app.core.config as cfg
from app.core.registry import _jobs
from app.core.take_video_config import (
    CAMERA_PART_FILE,
    CAMERA_WEBM,
    DROP_NOT_VIDEO,
    DROP_PARTS_MISSING,
    TAKE_CAMERA_MAX_BYTES_PER_SEC,
)
from app.core.takes import has_takes
from app.core.takes_config import TAKE_SLACK_SEC, TAKE_WAV_FILE, TAKES_DIRNAME
from tests._take_video_helpers import (
    CAMERA_START,
    filmed_take,
    make_camera,
    upload_camera,
    video_track,
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
    start_body,
)
from tests.ffmpeg_probe import skip_without_ffmpeg

BASE = f"/api/jobs/{JOB}"
TAKE_SEC = 3
LONG_PCM = pcm(CAPTURE_RATE * TAKE_SEC)


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client():
    add_done_job(cfg.JOBS_DIR)
    return make_client()


@pytest.fixture
def camera(tmp_path):
    skip_without_ffmpeg()
    return make_camera(tmp_path / "cam.webm")


def _folder(take_id: str):
    return cfg.JOBS_DIR / JOB / TAKES_DIRNAME / take_id


def _camera_part(client, take_id: str, seq: int, data: bytes):
    return client.put(f"{BASE}/takes/{take_id}/camera/parts?seq={seq}", content=data, headers=OCTET)


def _finish(client, take_id: str, parts: int, offset_ms: float = 0.0):
    camera = {"first_frame_offset_ms": offset_ms, "first_frame_clock": "capture", "parts": parts}
    return client.post(f"{BASE}/takes/{take_id}/finish", json={"camera": camera})


def test_video_track_keeps_kind_and_i_play(client):
    r = client.post(f"{BASE}/tracks", json={"kind": "video", "i_play": ["guitar", "guitar"]})
    assert r.status_code == 201
    assert (r.json()["kind"], r.json()["i_play"]) == ("video", ["guitar"])
    assert client.post(f"{BASE}/tracks", json={"i_play": ["kazoo"]}).status_code == 422
    track = r.json()["id"]
    patched = client.patch(f"{BASE}/tracks/{track}", json={"i_play": ["vocals"]}).json()
    assert patched["i_play"] == ["vocals"]
    new_track(client)
    assert client.get(f"{BASE}/takes").json()["tracks"][1]["kind"] == "audio"


def test_camera_on_an_audio_track_is_refused(client):
    track = new_track(client)
    r = client.post(f"{BASE}/takes", json=start_body(track, camera=CAMERA_START))
    assert r.status_code == 422


def test_take_copies_the_tracks_i_play(client, camera):
    track = video_track(client, ["vocals"])
    entry = filmed_take(client, track, camera, audio=LONG_PCM)
    client.patch(f"{BASE}/tracks/{track}", json={"i_play": ["bass"]})
    listed = client.get(f"{BASE}/takes").json()["takes"][0]
    assert entry["i_play"] == listed["i_play"] == ["vocals"]


def test_camera_parts_follow_the_audio_rules(client):
    take = new_take(client, video_track(client), camera=CAMERA_START)
    assert _camera_part(client, take, 0, b"a" * 10).json()["duplicate"] is False
    assert _camera_part(client, take, 0, b"a" * 10).json()["duplicate"] is True
    assert _camera_part(client, take, 2, b"b").status_code == 409
    assert _camera_part(client, take, 1, b"").status_code == 422
    parts = client.get(f"{BASE}/takes/{take}/parts").json()
    assert parts["camera"] == {"next_seq": 1, "bytes": 10}
    assert (_folder(take) / CAMERA_PART_FILE).stat().st_size == 10


def test_camera_parts_need_a_camera_take(client):
    take = new_take(client, video_track(client))
    assert _camera_part(client, take, 0, b"x").status_code == 404
    assert "camera" not in client.get(f"{BASE}/takes/{take}/parts").json()


def test_camera_cap_is_413(client, monkeypatch):
    from app.api import takes_camera

    take = new_take(client, video_track(client), camera=CAMERA_START)
    cap = int((SONG_SEC + TAKE_SLACK_SEC) * TAKE_CAMERA_MAX_BYTES_PER_SEC)
    assert takes_camera.camera_cap(_jobs[JOB]) == cap
    monkeypatch.setattr(takes_camera, "TAKE_CAMERA_MAX_BYTES_PER_SEC", 0)
    assert _camera_part(client, take, 0, b"x").status_code == 413


def test_finish_keeps_the_camera_file(client, camera):
    entry = filmed_take(client, video_track(client), camera, first_frame_offset_ms=-41.7)
    folder = _folder(entry["id"])
    assert (folder / CAMERA_WEBM).read_bytes() == camera.read_bytes()
    assert not (folder / CAMERA_PART_FILE).exists()
    assert entry["has_camera"] and entry["camera_dropped"] is None
    assert entry["camera_url"] == f"{BASE}/takes/{entry['id']}/camera"
    r = client.get(entry["camera_url"], headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and len(r.content) == 10


@pytest.mark.parametrize("mp4", [False, True])
def test_finish_records_what_the_file_holds(client, tmp_path, mp4):
    skip_without_ffmpeg()
    clip = make_camera(tmp_path / ("cam.mp4" if mp4 else "cam.webm"), seconds=2.0)
    entry = filmed_take(client, video_track(client), clip)
    sidecar = (_folder(entry["id"]) / "take.json").read_text()
    assert ('"camera.mp4"' if mp4 else '"camera.webm"') in sidecar
    assert '"duration_sec": 2.0' in sidecar.replace("2.000000", "2.0")


def test_missing_parts_drop_the_picture_and_keep_the_sound(client, camera):
    take = new_take(client, video_track(client), camera=CAMERA_START)
    put_part(client, take, 0, pcm())
    parts = upload_camera(client, take, camera.read_bytes())
    r = _finish(client, take, parts + 1)
    assert r.status_code == 200
    assert (r.json()["has_camera"], r.json()["camera_dropped"]) == (False, DROP_PARTS_MISSING)
    assert (_folder(take) / TAKE_WAV_FILE).is_file()
    assert not (_folder(take) / CAMERA_PART_FILE).exists()


def test_bytes_that_are_not_video_drop_the_picture(client):
    take = new_take(client, video_track(client), camera=CAMERA_START)
    put_part(client, take, 0, pcm())
    _camera_part(client, take, 0, b"\x1a\x45\xdf\xa3 not really a webm")
    r = _finish(client, take, 1)
    assert (r.json()["has_camera"], r.json()["camera_dropped"]) == (False, DROP_NOT_VIDEO)
    assert client.get(f"{BASE}/takes/{take}/camera").status_code == 404


def test_has_takes_counts_camera_chunks_alone(client):
    take = new_take(client, video_track(client), camera=CAMERA_START)
    job_dir = cfg.JOBS_DIR / JOB
    assert not has_takes(job_dir)
    _camera_part(client, take, 0, b"chunk")
    assert has_takes(job_dir)


def _patch(client, take_id: str, **body):
    return client.patch(f"{BASE}/takes/{take_id}", json=body)


def test_trim_changes_only_the_export_range(client, camera):
    entry = filmed_take(client, video_track(client), camera, audio=LONG_PCM)
    wav = _folder(entry["id"]) / TAKE_WAV_FILE
    mtime = wav.stat().st_mtime_ns
    span = entry["span"]
    trim = {"in_sec": span["start_sec"] + 0.5, "out_sec": span["start_sec"] + 2.0}
    r = _patch(client, entry["id"], trim=trim)
    assert r.status_code == 200 and r.json()["trim"] == trim
    assert wav.stat().st_mtime_ns == mtime
    assert _patch(client, entry["id"], trim=None).json()["trim"] is None


@pytest.mark.parametrize(
    ("lo", "hi"),
    [(-0.3, 1.5), (0.5, 9.0), (0.6, 1.2)],
    ids=["before", "after", "short"],
)
def test_bad_trims_are_422(client, camera, lo, hi):
    entry = filmed_take(client, video_track(client), camera, audio=LONG_PCM)
    start = entry["span"]["start_sec"]
    trim = {"in_sec": max(0.0, start + lo), "out_sec": start + hi}
    assert _patch(client, entry["id"], trim=trim).status_code == 422


def test_camera_offset_moves_only_the_picture(client, camera):
    entry = filmed_take(client, video_track(client), camera)
    r = _patch(client, entry["id"], camera_offset_ms=80.0)
    assert r.json()["camera_offset_ms"] == 80.0
    assert r.json()["placement_sec"] == entry["placement_sec"]
    assert _patch(client, entry["id"], camera_offset_ms=5000.0).status_code == 422


def test_camera_offset_needs_a_camera(client):
    track = new_track(client)
    take = new_take(client, track)
    put_part(client, take, 0, pcm())
    client.post(f"{BASE}/takes/{take}/finish", json={})
    assert _patch(client, take, camera_offset_ms=10.0).status_code == 422


def test_a_restart_lists_the_camera(client, camera):
    entry = filmed_take(client, video_track(client), camera)
    fresh = make_client()
    listed = fresh.get(f"{BASE}/takes").json()["takes"][0]
    assert listed["has_camera"] and listed["camera_url"] == entry["camera_url"]
