"""The filmed-take export routes: start, follow, cancel and download a
render, with real libx264 for the CPU path and the GPU encoder
mocked. Scratch jobs dir and probe cache."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from app.api import takes_video_render, takes_video_runs
from app.core.take_video_config import RENDER_FILE, RENDER_SIDECAR
from app.core.video_config import ENCODER_ENV, NVENC
from app.pipeline import video_encoder
from app.pipeline.video_encoder import Choice, EncodeError
from tests._take_render_helpers import (
    BASE,
    POLL_SEC,
    WAIT_SEC,
    client,
    render_isolation,
    start_render,
    take,
    take_folder,
    wait_render,
)
from tests._takes_helpers import JOB, make_client, new_track, recorded_take
from tests._video_helpers import fresh_encoders, needs_libx264

__all__ = ["client", "fresh_encoders", "render_isolation", "take"]

pytestmark = [needs_libx264, pytest.mark.usefixtures("render_isolation")]


def test_cpu_render_is_done_and_outlives_a_restart(client, take):
    assert start_render(client, take).status_code == 202
    view = wait_render(client, take)
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
    start_render(client, take)
    wait_render(client, take)
    span = client.get(f"{BASE}/takes").json()["takes"][0]["span"]
    trim = {"in_sec": span["start_sec"], "out_sec": span["start_sec"] + 1.5}
    client.patch(f"{BASE}/takes/{take}", json={"trim": trim})
    assert client.get(f"{BASE}/takes/{take}/render").json()["stale"] is True


class Held:
    """A render stuck in its encode: it has written part of its temp file,
    and `stopped` is set once the encode gave up on a cancel."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.stopped = threading.Event()
        self.temps: list[Path] = []

    def encode(self, job, setting, cancelled):
        job.dest.write_bytes(b"partial")
        self.temps.append(job.dest)
        try:
            while not self.release.wait(POLL_SEC):
                if cancelled():
                    raise EncodeError("cancelled")
            raise EncodeError("cancelled")
        finally:
            self.stopped.set()


@pytest.fixture
def held(monkeypatch):
    stuck = Held()
    monkeypatch.setattr(takes_video_runs, "encode", stuck.encode)
    yield stuck
    stuck.release.set()


def _wait_running(client, take_id: str, held: Held) -> None:
    wait_render(client, take_id, until=("running",))
    deadline = time.monotonic() + WAIT_SEC
    while not held.temps and time.monotonic() < deadline:
        time.sleep(POLL_SEC)
    assert held.temps and held.temps[0].is_file()


def test_a_second_render_is_409_and_cancel_keeps_the_old_file(client, take, held):
    (take_folder(take) / RENDER_FILE).write_bytes(b"previous")
    assert start_render(client, take).status_code == 202
    assert start_render(client, take).status_code == 409
    _wait_running(client, take, held)
    client.post(f"{BASE}/takes/{take}/render/cancel")
    assert wait_render(client, take)["status"] == "cancelled"
    assert held.stopped.is_set()
    assert (take_folder(take) / RENDER_FILE).read_bytes() == b"previous"
    assert not list(take_folder(take).glob(".render.mp4.*"))


def test_deleting_the_song_stops_itsstart_render(client, take, held):
    start_render(client, take)
    _wait_running(client, take, held)
    takes_video_runs.cancel_job_renders(JOB)
    assert held.stopped.is_set()
    assert not held.temps[0].exists()
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
    start_render(client, take)
    view = wait_render(client, take)
    assert (view["encoder"], view["fallback_reason"]) == ("libx264", reason)
    start_render(client, take)
    wait_render(client, take)
    assert NVENC in video_encoder.disabled()


def test_cpu_policy_never_probes(client, take, monkeypatch):
    def no_probe(*_a, **_k):
        raise AssertionError("probed under STEMDECK_VIDEO_ENCODER=cpu")

    monkeypatch.setattr(video_encoder, "probe", no_probe)
    start_render(client, take)
    assert wait_render(client, take)["status"] == "done"


def test_the_take_itself_cannot_be_in_the_backing(client, take):
    track = client.get(f"{BASE}/takes").json()["takes"][0]["track_id"]
    assert start_render(client, take, stems=[take], gains=[1.0]).status_code == 422
    assert start_render(client, take, stems=[track], gains=[1.0]).status_code == 422


def test_a_take_without_camera_is_422(client):
    audio = recorded_take(client, new_track(client))["id"]
    assert start_render(client, audio).status_code == 422


def test_no_libx264_is_503(client, take, monkeypatch):
    monkeypatch.setattr(takes_video_render, "render_tools_available", lambda: False)
    assert start_render(client, take).status_code == 503


def test_no_render_yet(client, take):
    view = client.get(f"{BASE}/takes/{take}/render").json()
    assert (view["status"], view["url"]) == ("none", None)
    assert client.get(f"{BASE}/takes/{take}/{RENDER_FILE}").status_code == 404
    assert not (take_folder(take) / RENDER_SIDECAR).exists()
