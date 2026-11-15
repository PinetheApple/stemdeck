"""Shared bits of the video encoder tests: real tiny MP4s made with the local
ffmpeg, and the module state every test starts from."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.core.config import ffmpeg_executable, ffprobe_executable
from app.core.video_config import (
    ENCODER_ENV,
    VAAPI_DEVICE_ENV,
    VIDEO_CPU_ENCODER,
    VIDEO_ENCODER_CACHE_FILE,
    VIDEO_PIX_FMT,
)
from app.pipeline import video_encoder, video_probe_store

TINY_W = 320
TINY_H = 180
TINY_FPS = 30
TINY_SEC = 2.0
_MAKE_TIMEOUT_SEC = 60


def _has_libx264() -> bool:
    if shutil.which(ffmpeg_executable()) is None or shutil.which(ffprobe_executable()) is None:
        return False
    out = subprocess.run(
        [ffmpeg_executable(), "-hide_banner", "-encoders"],
        capture_output=True,
        text=True,
        timeout=_MAKE_TIMEOUT_SEC,
        check=False,
    ).stdout
    return VIDEO_CPU_ENCODER in out


HAVE_LIBX264 = _has_libx264()
needs_libx264 = pytest.mark.skipif(not HAVE_LIBX264, reason="ffmpeg with libx264 not installed")


def make_mp4(
    dest: Path,
    width: int = TINY_W,
    height: int = TINY_H,
    fps: int = TINY_FPS,
    seconds: float = TINY_SEC,
    audio: bool = True,
    source: str = "testsrc2",
    source_options: str = "",
) -> Path:
    """A real H.264 (+ AAC) MP4 made with libx264 from a lavfi video source:
    testsrc2 moves, color with source_options "c=green" is one solid colour."""
    cmd = [ffmpeg_executable(), "-nostdin", "-v", "error", "-y", "-f", "lavfi"]
    options = f"s={width}x{height}:r={fps}:d={seconds}"
    options += f":{source_options}" if source_options else ""
    cmd += ["-i", f"{source}={options}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=f=440:d={seconds}", "-c:a", "aac"]
    cmd += ["-c:v", VIDEO_CPU_ENCODER, "-pix_fmt", VIDEO_PIX_FMT, str(dest)]
    subprocess.run(cmd, check=True, timeout=_MAKE_TIMEOUT_SEC)
    return dest


@pytest.fixture
def fresh_encoders(monkeypatch, tmp_path):
    """No env override, an empty probe cache in tmp, no failures counted."""
    monkeypatch.delenv(ENCODER_ENV, raising=False)
    monkeypatch.delenv(VAAPI_DEVICE_ENV, raising=False)
    monkeypatch.setattr(video_probe_store, "CACHE_PATH", tmp_path / VIDEO_ENCODER_CACHE_FILE)
    video_probe_store.reset_cache()
    video_encoder.reset_state()
    yield tmp_path
    video_probe_store.reset_cache()
    video_encoder.reset_state()
