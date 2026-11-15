"""Shared setup of the filmed-take render tests: a finished song, a filmed
take on it made through the routes, and the calls that render and follow it.
Renders run on libx264 (STEMDECK_VIDEO_ENCODER=cpu) unless a test says not."""

from __future__ import annotations

import time

import pytest

import app.core.config as cfg
from app.api import takes_video_runs
from app.core.registry import _jobs
from app.core.takes_config import TAKES_DIRNAME
from app.core.video_config import ENCODER_ENV
from tests._take_video_helpers import filmed_take, make_camera, video_track
from tests._takes_helpers import CAPTURE_RATE, JOB, add_done_job, make_client, pcm

BASE = f"/api/jobs/{JOB}"
TAKE_PCM = pcm(CAPTURE_RATE * 3)
BODY = {"stems": ["drums"], "gains": [1.0], "size": "720", "fps": 24}
POLL_SEC = 0.1
WAIT_SEC = 120.0


@pytest.fixture
def render_isolation(fresh_encoders, monkeypatch):
    _jobs.clear()
    monkeypatch.setenv(ENCODER_ENV, "cpu")
    yield
    _jobs.clear()
    takes_video_runs.RENDER_RUNS.runs.clear()


@pytest.fixture
def client():
    job = add_done_job(cfg.JOBS_DIR)
    job.title = "Song: A"
    with make_client() as c:
        yield c


@pytest.fixture
def take(client, tmp_path):
    camera = make_camera(tmp_path / "cam.webm")
    return filmed_take(client, video_track(client), camera, audio=TAKE_PCM)["id"]


def take_folder(take_id: str):
    return cfg.JOBS_DIR / JOB / TAKES_DIRNAME / take_id


def start_render(client, take_id: str, **over):
    return client.post(f"{BASE}/takes/{take_id}/render", json={**BODY, **over})


def wait_render(client, take_id: str, until=("done", "error", "cancelled")) -> dict:
    deadline = time.monotonic() + WAIT_SEC
    while time.monotonic() < deadline:
        view = client.get(f"{BASE}/takes/{take_id}/render").json()
        if view["status"] in until:
            return view
        time.sleep(POLL_SEC)
    raise AssertionError(f"render still {view['status']}")
