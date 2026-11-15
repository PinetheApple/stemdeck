"""Whether an encoded MP4 is the file that was asked for.

An encoder can exit 0 and still write the wrong thing: a wrong size or rate,
a truncated stream, frames a decoder chokes on. validate_output reads the
file back with ffprobe and then decodes all of it. Blocking: run it in a
thread.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from pathlib import Path

from app.core.config import ffmpeg_executable, ffprobe_executable
from app.core.video_config import (
    TIMEOUT_VIDEO_ENCODER_PROBE,
    VIDEO_LOW_DISK_BYTES,
    VIDEO_PROBE_MIN_DISTINCT_FRAMES,
    VIDEO_VALIDATE_DURATION_TOL_FRAMES,
    VIDEO_VALIDATE_DURATION_TOL_SEC,
    VIDEO_VALIDATE_FPS_TOL,
    VIDEO_VALIDATE_MIN_BYTES,
    VIDEO_VALIDATE_MIN_BYTES_PER_SEC,
    validate_timeout_sec,
)
from app.pipeline.video_encoder_args import size_cap_bytes
from app.pipeline.video_process import ProcessStopped, never, run_watched

CHECK_MISSING = "missing"
CHECK_FILESIZE = "filesize"
CHECK_PROBE = "probe"
CHECK_CODEC = "codec"
CHECK_SIZE = "size"
CHECK_FPS = "fps"
CHECK_AUDIO = "audio"
CHECK_DURATION = "duration"
CHECK_DECODE = "decode"
CHECK_UNIFORM = "uniform"

H264_CODEC = "h264"
_PROBE_FIELDS = "stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration"
_FRAMEMD5_COMMENT = "#"


class OutputInvalid(Exception):
    """The file is not what was asked for; `code` names the failed check."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def short_of_disk(path: Path) -> bool:
    """Whether the disk `path` is on is nearly full: a short file there is the
    disk's fault, not the encoder's."""
    try:
        return shutil.disk_usage(path.parent).free < VIDEO_LOW_DISK_BYTES
    except OSError:
        return False


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
        raise OutputInvalid(CHECK_MISSING) from None
    floor = max(VIDEO_VALIDATE_MIN_BYTES, duration_sec * VIDEO_VALIDATE_MIN_BYTES_PER_SEC)
    if not floor <= size <= size_cap_bytes(width, height, fps, duration_sec):
        raise OutputInvalid(CHECK_FILESIZE, f"{size} bytes")


def _probe_info(path: Path, cancelled: Callable[[], bool]) -> dict:
    cmd = [ffprobe_executable(), "-v", "error", "-show_entries", _PROBE_FIELDS]
    cmd += ["-of", "json", str(path)]
    rc, out, _err = _checked_run(cmd, TIMEOUT_VIDEO_ENCODER_PROBE, cancelled)
    if rc != 0:
        raise OutputInvalid(CHECK_PROBE)
    try:
        return json.loads(out or "{}")
    except ValueError:
        raise OutputInvalid(CHECK_PROBE) from None


def _check_streams(info: dict, width: int, height: int, fps: int, duration_sec: float) -> None:
    streams = info.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None or video.get("codec_name") != H264_CODEC:
        raise OutputInvalid(CHECK_CODEC, str(video and video.get("codec_name")))
    if (video.get("width"), video.get("height")) != (width, height):
        raise OutputInvalid(CHECK_SIZE, f"{video.get('width')}x{video.get('height')}")
    if abs(_fraction(video.get("r_frame_rate")) - fps) > VIDEO_VALIDATE_FPS_TOL:
        raise OutputInvalid(CHECK_FPS, str(video.get("r_frame_rate")))
    if not any(s.get("codec_type") == "audio" for s in streams):
        raise OutputInvalid(CHECK_AUDIO)
    got = _fraction(video.get("duration") or (info.get("format") or {}).get("duration"))
    tolerance = max(VIDEO_VALIDATE_DURATION_TOL_SEC, VIDEO_VALIDATE_DURATION_TOL_FRAMES / fps)
    if abs(got - duration_sec) > tolerance:
        raise OutputInvalid(CHECK_DURATION, f"{got:.3f} s of {duration_sec:.3f} s")


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
        raise OutputInvalid(CHECK_DECODE, err.strip().splitlines()[0] if err.strip() else "")


def check_moving_picture(
    path: Path,
    duration_sec: float,
    cancelled: Callable[[], bool] = never,
) -> None:
    """Raise OutputInvalid unless the decoded frames differ from each other.
    For the probe, whose source moves: a broken encoder can write a clean
    file of one solid colour."""
    cmd = [ffmpeg_executable(), "-nostdin", "-v", "error", "-i", str(path)]
    cmd += ["-map", "0:v:0", "-f", "framemd5", "-"]
    rc, out, _err = _checked_run(cmd, validate_timeout_sec(duration_sec), cancelled)
    if rc != 0:
        raise OutputInvalid(CHECK_DECODE)
    hashes = {
        line.rsplit(",", 1)[-1].strip()
        for line in out.splitlines()
        if line.strip() and not line.startswith(_FRAMEMD5_COMMENT)
    }
    if len(hashes) < VIDEO_PROBE_MIN_DISTINCT_FRAMES:
        raise OutputInvalid(CHECK_UNIFORM, f"{len(hashes)} distinct frames")
