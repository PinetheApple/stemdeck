"""Run ffmpeg or ffprobe to the end under a time limit and a cancel flag.

The child gets its own process group, so a kill also stops anything it
started. Blocking: run it in a thread.
"""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from collections.abc import Callable

STOP_TIMEOUT = "timeout"
STOP_CANCELLED = "cancelled"
_WATCH_POLL_SEC = 0.25
_POSIX = os.name == "posix"


def never() -> bool:
    return False


class ProcessStopped(Exception):
    """A watched process was killed: `reason` is "timeout" or "cancelled"."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _kill(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if _POSIX:
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            proc.kill()
    except ProcessLookupError:
        return


def _watch(
    proc: subprocess.Popen,
    timeout: float,
    cancelled: Callable[[], bool],
    stop: threading.Event,
    why: list[str],
) -> None:
    deadline = time.monotonic() + timeout
    while not stop.wait(_WATCH_POLL_SEC):
        if proc.poll() is not None:
            return
        if cancelled() or time.monotonic() > deadline:
            why.append(STOP_CANCELLED if cancelled() else STOP_TIMEOUT)
            _kill(proc)
            return


def run_watched(
    cmd: list[str],
    timeout: float,
    cancelled: Callable[[], bool] = never,
) -> tuple[int, str, str]:
    """Run to the end and return (returncode, stdout, stderr). Killed with its
    process group on the timeout or a cancel, which raise ProcessStopped. A
    process that exited 0 on its own as the limit hit is not reported stopped."""
    if cancelled():
        raise ProcessStopped(STOP_CANCELLED)
    proc = subprocess.Popen(  # noqa: S603 -- list args, trusted ffmpeg/ffprobe
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        start_new_session=_POSIX,
    )
    stop = threading.Event()
    why: list[str] = []
    guard = threading.Thread(
        target=_watch,
        args=(proc, timeout, cancelled, stop, why),
        daemon=True,
    )
    guard.start()
    try:
        out, err = proc.communicate()
    finally:
        stop.set()
        guard.join()
    if why and proc.returncode != 0:
        raise ProcessStopped(why[0])
    return proc.returncode, out, err
