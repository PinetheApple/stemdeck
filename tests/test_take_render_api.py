"""The filmed-take export routes (#102, #99): start, follow, cancel and
download a render, with real libx264 for the CPU path and the GPU encoder
mocked. Scratch jobs dir and probe cache."""

from __future__ import annotations

import threading
import time

import pytest

import app.core.config as cfg
from app.api import takes_video_render, takes_video_runs
from app.core.registry import _jobs
from app.core.take_video_config import RENDER_FILE, RENDER_SIDECAR
from app.core.takes_config import TAKES_DIRNAME
from app.core.video_config import ENCODER_ENV, NVENC
from app.pipeline import video_encoder
from app.pipeline.video_encoder import Choice, EncodeError
from tests._take_video_helpers import filmed_take, make_camera, video_track
from tests._takes_helpers import (
    CAPTURE_RATE,
    JOB,
    add_done_job,
    make_client,
    new_track,
    pcm,
    recorded_take,
)
from tests._video_helpers import fresh_encoders, needs_libx264

__all__ = ["fresh_encoders"]

pytestmark = needs_libx264

BASE = f"/api/jobs/{JOB}"
TAKE_PCM = pcm(CAPTURE_RATE * 3)
BODY = {"stems": ["drums"], "gains": [1.0], "size": "720", "fps": 24}
POLL_SEC = 0.1
WAIT_SEC = 120.0


@pytest.fixture(autouse=True)
def _isolate(fresh_encoders, monkeypatch):
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


def _folder(take_id: str):
    return cfg.JOBS_DIR / JOB / TAKES_DIRNAME / take_id


def _render(client, take_id: str, **over):
    return client.post(f"{BASE}/takes/{take_id}/render", json={**BODY, **over})


def _wait(client, take_id: str, until=("done", "error", "cancelled")) -> dict:
    deadline = time.monotonic() + WAIT_SEC
    while time.monotonic() < deadline:
        view = client.get(f"{BASE}/takes/{take_id}/render").json()
        if view["status"] in until:
            return view
        time.sleep(POLL_SEC)
    raise AssertionError(f"render still {view['status']}")


def test_cpu_render_is_done_and_outlives_a_restart(client, take):
    assert _render(client, take).status_code == 202
    view = _wait(client, take)
    assert (view["status"], view["encoder"], view["family"]) == ("done", "libx264", "cpu")
    assert view["url"] == f"{BASE}/takes/{take}/{RENDER_FILE}" and not view["stale"]
    with make_client() as fresh:
        again = fresh.get(f"{BASE}/takes/{take}/render").json()
    assert (again["status"], again["encoder"]) == ("done", "libx264")
    r = client.get(view["url"])
    assert (
        r.status_code == 200 and 'filename="Song_A_Take_1.mp4"' in r.headers["content-disposition"]
    )


def test_trim_makes_the_render_stale(client, take):
    _render(client, take)
    _wait(client, take)
    span = client.get(f"{BASE}/takes").json()["takes"][0]["span"]
    trim = {"in_sec": span["start_sec"], "out_sec": span["start_sec"] + 1.5}
    client.patch(f"{BASE}/takes/{take}", json={"trim": trim})
    assert client.get(f"{BASE}/takes/{take}/render").json()["stale"] is True


@pytest.fixture
def held(monkeypatch):
    """Renders block until the event is set, then fail as cancelled when asked."""
    release = threading.Event()

    def blocked_encode(job, setting, cancelled):
        while not release.wait(POLL_SEC):
            if cancelled():
                raise EncodeError("cancelled")
        raise EncodeError("cancelled")

    monkeypatch.setattr(takes_video_runs, "encode", blocked_encode)
    yield release
    release.set()


def test_a_second_render_is_409_and_cancel_keeps_the_old_file(client, take, held):
    (_folder(take) / RENDER_FILE).write_bytes(b"previous")
    assert _render(client, take).status_code == 202
    assert _render(client, take).status_code == 409
    client.post(f"{BASE}/takes/{take}/render/cancel")
    assert _wait(client, take)["status"] == "cancelled"
    assert (_folder(take) / RENDER_FILE).read_bytes() == b"previous"
    assert not list(_folder(take).glob(".render.mp4.*"))


def test_deleting_the_song_cancels_its_render(client, take, held):
    _render(client, take)
    _wait(client, take, until=("running",))
    takes_video_runs.cancel_job_renders(JOB)
    assert takes_video_runs.RENDER_RUNS.current(takes_video_runs.run_key(JOB, take)) is None


def _gpu_fails_with(monkeypatch, failure):
    """Auto picks NVENC; its render fails as `failure` does, libx264 runs for real."""
    monkeypatch.delenv(ENCODER_ENV)
    monkeypatch.setattr(video_encoder, "choose", lambda *a, **k: Choice(NVENC))
    real = takes_video_runs.run_render

    def run(cmd, timeout, stall, cancelled, on_time):
        if NVENC in cmd:
            return failure(cmd)
        return real(cmd, timeout, stall, cancelled, on_time)

    monkeypatch.setattr(takes_video_runs, "run_render", run)


def _raise(code: str, stderr: str = ""):
    def fail(_cmd):
        raise EncodeError(code, stderr)

    return fail


def _junk_output(cmd):
    with open(cmd[-1], "wb") as fh:
        fh.write(b"\0" * 10_000)


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (_raise("exit", "[h264_nvenc @ 0x5] OpenEncodeSessionEx failed"), "exit"),
        (_raise("stall"), "stall"),
        (_junk_output, "invalid-probe"),
    ],
    ids=["exit", "stall", "invalid"],
)
def test_a_failed_gpu_render_is_redone_on_the_cpu(client, take, monkeypatch, failure, reason):
    _gpu_fails_with(monkeypatch, failure)
    _render(client, take)
    view = _wait(client, take)
    assert (view["encoder"], view["fallback_reason"]) == ("libx264", reason)
    _render(client, take)
    _wait(client, take)
    assert NVENC in video_encoder.disabled()


def test_cpu_policy_never_probes(client, take, monkeypatch):
    def no_probe(*_a, **_k):
        raise AssertionError("probed under STEMDECK_VIDEO_ENCODER=cpu")

    monkeypatch.setattr(video_encoder, "probe", no_probe)
    _render(client, take)
    assert _wait(client, take)["status"] == "done"


def test_the_take_itself_cannot_be_in_the_backing(client, take):
    track = client.get(f"{BASE}/takes").json()["takes"][0]["track_id"]
    assert _render(client, take, stems=[take], gains=[1.0]).status_code == 422
    assert _render(client, take, stems=[track], gains=[1.0]).status_code == 422


def test_a_take_without_camera_is_422(client):
    audio = recorded_take(client, new_track(client))["id"]
    assert _render(client, audio).status_code == 422


def test_no_libx264_is_503(client, take, monkeypatch):
    monkeypatch.setattr(takes_video_render, "render_tools_available", lambda: False)
    assert _render(client, take).status_code == 503


def test_no_render_yet(client, take):
    view = client.get(f"{BASE}/takes/{take}/render").json()
    assert (view["status"], view["url"]) == ("none", None)
    assert client.get(f"{BASE}/takes/{take}/{RENDER_FILE}").status_code == 404
    assert not (_folder(take) / RENDER_SIDECAR).exists()
