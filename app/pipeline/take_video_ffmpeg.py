"""Run a take render's ffmpeg and follow it: progress from `-progress
pipe:1`, killed (with its process group) on a cancel, the time limit, or a
GPU encoder that stops making progress. Blocking: run it in a thread.

Failures raise video_encoder.EncodeError with the code the encoder module
decides blame on: "exit", "stall", "timeout" or "cancelled".
"""

from __future__ import annotations

import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable
from typing import IO

from app.pipeline.video_encoder import EncodeError
from app.pipeline.video_probe import CODE_EXIT
from app.pipeline.video_process import STOP_CANCELLED, STOP_TIMEOUT, kill_group, spawn_group

CODE_STALL = "stall"
_OUT_TIME_KEY = "out_time_us"
_US_PER_SEC = 1_000_000
_STDERR_TAIL_LINES = 40
_POLL_SEC = 0.25


class _Progress:
    """The latest output time ffmpeg reported, and when it last moved."""

    def __init__(self, on_time: Callable[[float], None]) -> None:
        self.on_time = on_time
        self.moved_at = time.monotonic()

    def read(self, stream: IO[str]) -> None:
        for line in stream:
            key, _, value = line.strip().partition("=")
            if key != _OUT_TIME_KEY or not value.lstrip("-").isdigit():
                continue
            self.moved_at = time.monotonic()
            self.on_time(max(0, int(value)) / _US_PER_SEC)


def _drain(stream: IO[str], tail: deque[str]) -> None:
    for line in stream:
        tail.append(line)


def _stop_reason(
    started: float,
    progress: _Progress,
    timeout: float,
    stall: float | None,
    cancelled: Callable[[], bool],
) -> str | None:
    now = time.monotonic()
    if cancelled():
        return STOP_CANCELLED
    if now - started > timeout:
        return STOP_TIMEOUT
    if stall is not None and now - progress.moved_at > stall:
        return CODE_STALL
    return None


def _watch(
    proc: subprocess.Popen,
    progress: _Progress,
    timeout: float,
    stall: float | None,
    cancelled: Callable[[], bool],
) -> str | None:
    started = time.monotonic()
    while proc.poll() is None:
        why = _stop_reason(started, progress, timeout, stall, cancelled)
        if why is not None:
            kill_group(proc)
            return why
        time.sleep(_POLL_SEC)
    return None


def run_render(
    cmd: list[str],
    timeout: float,
    stall: float | None,
    cancelled: Callable[[], bool],
    on_time: Callable[[float], None],
) -> None:
    """Run `cmd` to the end, reporting each output time in seconds."""
    if cancelled():
        raise EncodeError(STOP_CANCELLED)
    proc = spawn_group(cmd)
    progress = _Progress(on_time)
    tail: deque[str] = deque(maxlen=_STDERR_TAIL_LINES)
    readers = [
        threading.Thread(target=progress.read, args=(proc.stdout,), daemon=True),
        threading.Thread(target=_drain, args=(proc.stderr, tail), daemon=True),
    ]
    for reader in readers:
        reader.start()
    why = _watch(proc, progress, timeout, stall, cancelled)
    proc.wait()
    for reader in readers:
        reader.join()
    if why is not None:
        raise EncodeError(why, "".join(tail))
    if proc.returncode != 0:
        raise EncodeError(CODE_EXIT, "".join(tail))
