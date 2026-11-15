"""run_watched: a kill takes the whole process group, and a process that
ended on its own is never reported stopped."""

from __future__ import annotations

import os
import sys
import time

import pytest

from app.pipeline import video_process
from app.pipeline.video_process import STOP_CANCELLED, STOP_TIMEOUT, ProcessStopped, run_watched

pytestmark = pytest.mark.skipif(os.name != "posix", reason="process groups are POSIX")

_SPAWN_AND_WAIT = """
import subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
open(sys.argv[1], "w").write(str(child.pid))
time.sleep(30)
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _wait_for(path, seconds=10.0) -> str:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists() and path.read_text():
            return path.read_text()
        time.sleep(0.05)
    raise AssertionError("child never started")


def test_a_timeout_kills_the_grandchild_too(tmp_path):
    marker = tmp_path / "child.pid"
    with pytest.raises(ProcessStopped) as caught:
        run_watched([sys.executable, "-c", _SPAWN_AND_WAIT, str(marker)], timeout=1.5)
    assert caught.value.reason == STOP_TIMEOUT
    pid = int(_wait_for(marker))
    deadline = time.monotonic() + 5
    while _alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(pid)


def test_a_cancel_stops_the_process():
    started = time.monotonic()
    with pytest.raises(ProcessStopped) as caught:
        run_watched(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            timeout=60,
            cancelled=lambda: time.monotonic() - started > 0.5,
        )
    assert caught.value.reason == STOP_CANCELLED


def test_an_exit_on_its_own_at_the_limit_is_not_stopped(monkeypatch):
    monkeypatch.setattr(video_process, "_kill", lambda proc: None)
    rc, _out, _err = run_watched(
        [sys.executable, "-c", "import time; time.sleep(0.8)"],
        timeout=0.3,
    )
    assert rc == 0


def test_output_comes_back():
    rc, out, _err = run_watched([sys.executable, "-c", "print('hi')"], timeout=30)
    assert (rc, out.strip()) == (0, "hi")
