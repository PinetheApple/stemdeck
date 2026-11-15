"""The recording track routes (app/api/takes_tracks.py): a track is one
mixer lane that owns takes and plays its active one."""

from __future__ import annotations

import json

import pytest

import app.core.config as cfg
from app.api import takes_tracks
from app.core.registry import _jobs
from app.core.takes_config import PARTS_FILE, TAKES_DIRNAME, TRACKS_FILE
from tests._takes_helpers import JOB, add_done_job, make_client, new_take, new_track, recorded_take
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
def client(jobs_dir):
    add_done_job(jobs_dir)
    return make_client()


@pytest.fixture
def needs_ffmpeg():
    skip_without_ffmpeg()


def _tracks(client):
    return client.get(f"{BASE}/takes").json()["tracks"]


def test_create_names_tracks_in_turn(client):
    first = client.post(f"{BASE}/tracks", json={})
    assert first.status_code == 201
    assert first.json()["name"] == "Track 1"
    assert first.json()["active_take_id"] is None
    second = client.post(f"{BASE}/tracks", json={"name": "Bass DI"}).json()
    assert (second["name"], second["order"]) == ("Bass DI", 1)
    assert client.post(f"{BASE}/tracks", json={}).json()["name"] == "Track 3"


def test_create_stores_the_input(client):
    body = {"input": {"device_id": "abc", "device_label": "USB", "channels": [0, 1]}}
    track = client.post(f"{BASE}/tracks", json=body).json()
    assert track["input"] == body["input"]


def test_create_refuses_a_stereo_pair_of_one_channel(client):
    body = {"input": {"channels": [1, 1]}}
    assert client.post(f"{BASE}/tracks", json=body).status_code == 422


def test_create_stops_at_the_per_song_limit(client, monkeypatch):
    monkeypatch.setattr(takes_tracks, "TRACK_MAX_PER_JOB", 1)
    new_track(client)
    assert client.post(f"{BASE}/tracks", json={}).status_code == 409


def test_tracks_survive_a_restart(client, jobs_dir):
    track_id = new_track(client, name="Vox")
    saved = json.loads((jobs_dir / JOB / TAKES_DIRNAME / TRACKS_FILE).read_text(encoding="utf-8"))
    assert saved["v"] == 1 and saved["tracks"][0]["id"] == track_id
    assert [t["name"] for t in _tracks(make_client())] == ["Vox"]


def test_patch_renames_and_moves(client):
    a = new_track(client)
    b = new_track(client)
    r = client.patch(f"{BASE}/tracks/{b}", json={"name": "Lead", "order": 0})
    assert r.status_code == 200 and r.json()["name"] == "Lead"
    assert [t["id"] for t in _tracks(client)] == [b, a]


def test_patch_input_null_clears_it(client):
    track_id = new_track(client, input={"channels": [0]})
    r = client.patch(f"{BASE}/tracks/{track_id}", json={"input": None})
    assert r.json()["input"] is None


def test_patch_nothing_is_422(client):
    track_id = new_track(client)
    assert client.patch(f"{BASE}/tracks/{track_id}", json={}).status_code == 422


def test_patch_unknown_track_is_404(client):
    assert client.patch(f"{BASE}/tracks/k00000000", json={"name": "x"}).status_code == 404


@pytest.mark.usefixtures("needs_ffmpeg")
def test_active_take_must_be_a_finished_take_of_the_track(client):
    a = new_track(client)
    b = new_track(client)
    first = recorded_take(client, a)
    second = recorded_take(client, a)
    other = recorded_take(client, b)
    open_id = new_take(client, a)
    url = f"{BASE}/tracks/{a}"
    assert (
        client.patch(url, json={"active_take_id": first["id"]}).json()["active_take_id"]
        == (first["id"])
    )
    assert client.patch(url, json={"active_take_id": other["id"]}).status_code == 422
    assert client.patch(url, json={"active_take_id": open_id}).status_code == 422
    assert second["id"] != first["id"]


@pytest.mark.usefixtures("needs_ffmpeg")
def test_delete_removes_the_track_and_all_its_takes(client, jobs_dir):
    a = new_track(client)
    b = new_track(client)
    finished = recorded_take(client, a)
    open_id = new_take(client, a)
    kept = recorded_take(client, b)
    r = client.delete(f"{BASE}/tracks/{a}")
    assert r.status_code == 200
    assert r.json()["takes_deleted"] == sorted([finished["id"], open_id])
    takes_dir = jobs_dir / JOB / TAKES_DIRNAME
    assert not (takes_dir / finished["id"]).exists()
    assert not (takes_dir / open_id).exists()
    listed = client.get(f"{BASE}/takes").json()
    assert [t["id"] for t in listed["tracks"]] == [b]
    assert [t["id"] for t in listed["takes"]] == [kept["id"]]
    assert listed["tracks"][0]["order"] == 0


@pytest.mark.usefixtures("needs_ffmpeg")
def test_delete_finds_a_finished_take_by_its_sidecar(client, jobs_dir):
    track_id = new_track(client)
    finished = recorded_take(client, track_id)
    folder = jobs_dir / JOB / TAKES_DIRNAME / finished["id"]
    (folder / PARTS_FILE).write_text("{broken", encoding="utf-8")
    r = client.delete(f"{BASE}/tracks/{track_id}")
    assert r.json()["takes_deleted"] == [finished["id"]]
    assert not folder.exists()


def test_delete_unknown_track_is_404(client):
    assert client.delete(f"{BASE}/tracks/k00000000").status_code == 404
