"""How a filmed-take render fails and what it leaves: a plain error code for
every failure, render.json that never describes a file it did not make, and
no temp file outliving a crash. Real libx264 where a render must finish."""

from __future__ import annotations

import errno
import os
import time

import pytest

import app.core.config as cfg
from app.api import takes_video_runs
from app.core.take_video_config import RENDER_FILE
from app.core.video_config import TIMEOUT_VIDEO_RENDER_MAX
from app.pipeline.video_encoder import EncodeError
from tests._take_render_helpers import (
    BASE,
    client,
    render_isolation,
    start_render,
    take,
    take_folder,
    wait_render,
)
from tests._takes_helpers import JOB
from tests._video_helpers import fresh_encoders, needs_libx264

__all__ = ["client", "fresh_encoders", "render_isolation", "take"]

pytestmark = [needs_libx264, pytest.mark.usefixtures("render_isolation")]

PREVIOUS = b"previous render"
DISK_FULL = "disk-full"
# Older than any render can run, so no render can still be writing it.
STALE_AGE_SEC = TIMEOUT_VIDEO_RENDER_MAX + 60


def _temp_name() -> str:
    return ".render.mp4.0123456789abcdef0123456789abcdef.tmp"


def _no_space(*_args, **_kwargs):
    raise OSError(errno.ENOSPC, "No space left on device")


def _view(client, take_id: str) -> dict:
    return client.get(f"{BASE}/takes/{take_id}/render").json()


def _restart() -> None:
    takes_video_runs.RENDER_RUNS.runs.clear()


def test_a_full_disk_at_the_replace_is_a_plain_error(client, take, monkeypatch):
    (take_folder(take) / RENDER_FILE).write_bytes(PREVIOUS)
    real = os.replace

    def replace(src, dst):
        if str(dst).endswith(RENDER_FILE):
            _no_space()
        return real(src, dst)

    monkeypatch.setattr(takes_video_runs.os, "replace", replace)
    start_render(client, take)
    view = wait_render(client, take)
    assert (view["status"], view["error"]) == ("error", DISK_FULL)
    assert (take_folder(take) / RENDER_FILE).read_bytes() == PREVIOUS
    assert not list(take_folder(take).glob(".render.mp4.*"))


def test_render_json_failing_leaves_the_old_render_in_place(client, take, monkeypatch):
    (take_folder(take) / RENDER_FILE).write_bytes(PREVIOUS)
    monkeypatch.setattr(takes_video_runs, "write_json_atomic", _no_space)
    start_render(client, take)
    assert wait_render(client, take)["error"] == DISK_FULL
    assert (take_folder(take) / RENDER_FILE).read_bytes() == PREVIOUS


def test_render_json_never_describes_another_file(client, take):
    start_render(client, take)
    assert wait_render(client, take)["encoder"] == "libx264"
    (take_folder(take) / RENDER_FILE).write_bytes(PREVIOUS)
    _restart()
    view = _view(client, take)
    assert (view["status"], view["encoder"], view["stale"]) == ("done", None, True)


@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (EncodeError("exit", "out.mp4: No space left on device"), DISK_FULL),
        (EncodeError("timeout"), "timeout"),
        (RuntimeError("anything else"), "failed"),
    ],
    ids=["ffmpeg-disk-full", "timeout", "unexpected"],
)
def test_every_failure_has_a_code(client, take, monkeypatch, failure, code):
    def fail(job, setting, cancelled):
        raise failure

    monkeypatch.setattr(takes_video_runs, "encode", fail)
    start_render(client, take)
    assert wait_render(client, take)["error"] == code


def test_a_render_clears_its_takes_leftover_temps(client, take):
    leftover = take_folder(take) / _temp_name()
    leftover.write_bytes(b"crashed")
    start_render(client, take)
    assert wait_render(client, take)["status"] == "done"
    assert not leftover.exists()


def _aged(path, age_sec: float):
    path.write_bytes(b"crashed")
    then = time.time() - age_sec
    os.utime(path, (then, then))
    return path


def test_first_use_sweeps_old_temps_of_every_take(client, take, monkeypatch):
    other = cfg.JOBS_DIR / "fedcbafedcba" / "takes" / "t0000000a"
    other.mkdir(parents=True)
    old = _aged(other / _temp_name(), STALE_AGE_SEC)
    fresh = _aged(other / _temp_name().replace("0123", "4567"), 0)
    monkeypatch.setattr(takes_video_runs, "_swept_at_start", False)
    _view(client, take)
    assert not old.exists() and fresh.exists()


def test_the_sweep_spares_a_running_render(client, take, monkeypatch):
    live = _aged(take_folder(take) / _temp_name(), STALE_AGE_SEC)
    run = takes_video_runs.RENDER_RUNS.claim(takes_video_runs.run_key(JOB, take))
    run.tmp = live
    takes_video_runs.sweep_stale_temps(cfg.JOBS_DIR)
    assert live.exists()


def test_a_record_of_another_file_lends_it_no_settings(client, take, monkeypatch):
    (take_folder(take) / RENDER_FILE).write_bytes(PREVIOUS)
    real = os.replace

    def replace(src, dst):
        if str(dst).endswith(RENDER_FILE):
            _no_space()
        return real(src, dst)

    monkeypatch.setattr(takes_video_runs.os, "replace", replace)
    start_render(client, take)
    assert wait_render(client, take)["error"] == DISK_FULL
    _restart()
    view = _view(client, take)
    shown = {name: view[name] for name in ("size", "fps", "span", "encoder", "stale")}
    assert view["status"] == "done"
    assert shown == {"size": None, "fps": None, "span": None, "encoder": None, "stale": True}
