"""Whether an encoded MP4 is the file that was asked for.

A GPU encoder can exit 0 and still write the wrong thing: a wrong size or
rate, a truncated stream, frames a decoder chokes on. validate_output reads
the file back with ffprobe and then decodes all of it. Blocking: run it in a
thread. Every subprocess gets list arguments from trusted binaries.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path

from app.core.config import ffmpeg_executable, ffprobe_executable
from app.core.video_config import (
    TIMEOUT_VIDEO_ENCODER_PROBE,
    VIDEO_VALIDATE_DURATION_TOL_FRAMES,
    VIDEO_VALIDATE_DURATION_TOL_SEC,
    VIDEO_VALIDATE_FPS_TOL,
    VIDEO_VALIDATE_MIN_BYTES,
    VIDEO_VALIDATE_MIN_BYTES_PER_SEC,
    validate_timeout_sec,
)
from app.pipeline.video_encoder_args import size_cap_bytes

STOP_TIMEOUT = "timeout"
STOP_CANCELLED = "cancelled"
H264_CODEC = "h264"
_WATCH_POLL_SEC = 0.25
_PROBE_FIELDS = "stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration"


def never() -> bool:
    return False


class ProcessStopped(Exception):
    """A watched process was killed: `reason` is "timeout" or "cancelled"."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class OutputInvalid(Exception):
    """The file is not what was asked for; `code` names the failed check."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def _watch(
    proc: subprocess.Popen,
    timeout: float,
    cancelled: Callable[[], bool],
    stop: threading.Event,
    why: list[str],
) -> None:
    deadline = time.monotonic() + timeout
    while not stop.wait(_WATCH_POLL_SEC):
        if cancelled() or time.monotonic() > deadline:
            why.append(STOP_CANCELLED if cancelled() else STOP_TIMEOUT)
            proc.kill()
            return


def run_watched(
    cmd: list[str],
    timeout: float,
    cancelled: Callable[[], bool] = never,
) -> tuple[int, str, str]:
    """Run to the end and return (returncode, stdout, stderr). Killed on the
    timeout or a cancel, which raise ProcessStopped."""
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
    )
    stop = threading.Event()
    why: list[str] = []
    guard = threading.Thread(target=_watch, args=(proc, timeout, cancelled, stop, why), daemon=True)
    guard.start()
    try:
        out, err = proc.communicate()
    finally:
        stop.set()
        guard.join()
    if why:
        raise ProcessStopped(why[0])
    return proc.returncode, out, err


def _fraction(value: object) -> float:
    try:
        num, _, den = str(value).partition("/")
        return float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return 0.0


def _checked_run(
    cmd: list[str],
    timeout: float,
    cancelled: Callable[[], bool],
) -> tuple[int, str, str]:
    try:
        return run_watched(cmd, timeout, cancelled)
    except ProcessStopped as exc:
        raise OutputInvalid(exc.reason) from None


def _check_size(path: Path, width: int, height: int, fps: int, duration_sec: float) -> None:
    try:
        size = path.stat().st_size
    except OSError:
        raise OutputInvalid("missing") from None
    floor = max(VIDEO_VALIDATE_MIN_BYTES, duration_sec * VIDEO_VALIDATE_MIN_BYTES_PER_SEC)
    if not floor <= size <= size_cap_bytes(width, height, fps, duration_sec):
        raise OutputInvalid("filesize", f"{size} bytes")


def _probe_info(path: Path, cancelled: Callable[[], bool]) -> dict:
    cmd = [
        ffprobe_executable(),
        "-v",
        "error",
        "-show_entries",
        _PROBE_FIELDS,
        "-of",
        "json",
        str(path),
    ]
    rc, out, _err = _checked_run(cmd, TIMEOUT_VIDEO_ENCODER_PROBE, cancelled)
    if rc != 0:
        raise OutputInvalid("probe")
    try:
        return json.loads(out or "{}")
    except ValueError:
        raise OutputInvalid("probe") from None


def _check_streams(info: dict, width: int, height: int, fps: int, duration_sec: float) -> None:
    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None or video.get("codec_name") != H264_CODEC:
        raise OutputInvalid("codec", str(video and video.get("codec_name")))
    if (video.get("width"), video.get("height")) != (width, height):
        raise OutputInvalid("size", f"{video.get('width')}x{video.get('height')}")
    if abs(_fraction(video.get("r_frame_rate")) - fps) > VIDEO_VALIDATE_FPS_TOL:
        raise OutputInvalid("fps", str(video.get("r_frame_rate")))
    if not any(s.get("codec_type") == "audio" for s in streams):
        raise OutputInvalid("audio")
    got = _fraction(video.get("duration") or (info.get("format") or {}).get("duration"))
    tolerance = max(VIDEO_VALIDATE_DURATION_TOL_SEC, VIDEO_VALIDATE_DURATION_TOL_FRAMES / fps)
    if abs(got - duration_sec) > tolerance:
        raise OutputInvalid("duration", f"{got:.3f} s of {duration_sec:.3f} s")


def validate_output(
    path: Path,
    width: int,
    height: int,
    fps: int,
    duration_sec: float,
    cancelled: Callable[[], bool] = never,
) -> None:
    """Raise OutputInvalid unless `path` is an H.264 + audio MP4 of this
    geometry and length that decodes from end to end with no error."""
    _check_size(path, width, height, fps, duration_sec)
    _check_streams(_probe_info(path, cancelled), width, height, fps, duration_sec)
    cmd = [ffmpeg_executable(), "-nostdin", "-v", "error", "-i", str(path), "-f", "null", "-"]
    rc, _out, err = _checked_run(cmd, validate_timeout_sec(duration_sec), cancelled)
    if rc != 0 or err.strip():
        raise OutputInvalid("decode", err.strip().splitlines()[0] if err.strip() else "")
