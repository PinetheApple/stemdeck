"""Shared bits of the video encoder tests: real tiny MP4s made with the local
ffmpeg, and the module state every test starts from."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.core.video_config import VIDEO_CPU_ENCODER
from app.pipeline import video_encoder, video_probe

TINY_W = 320
TINY_H = 180
TINY_FPS = 30
TINY_SEC = 2.0
_MAKE_TIMEOUT_SEC = 60


def _has_libx264() -> bool:
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        return False
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-encoders"],
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
) -> Path:
    """A real H.264 (+ AAC) MP4 from test sources, made with libx264."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi"]
    cmd += ["-i", f"testsrc2=s={width}x{height}:r={fps}:d={seconds}"]
    if audio:
        cmd += ["-f", "lavfi", "-i", f"sine=f=440:d={seconds}", "-c:a", "aac"]
    cmd += ["-c:v", VIDEO_CPU_ENCODER, "-pix_fmt", "yuv420p", str(dest)]
    subprocess.run(cmd, check=True, timeout=_MAKE_TIMEOUT_SEC)
    return dest


@pytest.fixture
def fresh_encoders(monkeypatch, tmp_path):
    """No env override, an empty probe cache in tmp, no failures counted."""
    monkeypatch.delenv("STEMDECK_VIDEO_ENCODER", raising=False)
    monkeypatch.delenv("STEMDECK_VAAPI_DEVICE", raising=False)
    monkeypatch.setattr(video_probe, "CACHE_PATH", tmp_path / "video_encoders.json")
    video_probe.reset_cache()
    video_encoder.reset_state()
    yield tmp_path
    video_probe.reset_cache()
    video_encoder.reset_state()
