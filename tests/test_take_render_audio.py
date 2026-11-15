"""The sound of a filmed take's MP4, rendered for real on libx264: the
"I play" stem is not in it, and the take and backing together stay under
the export ceiling (plus what the AAC encoder adds)."""

from __future__ import annotations

import subprocess

import numpy as np
import pytest
import soundfile as sf

import app.core.config as cfg
from app.api.takes_lanes import EXPORT_CEILING
from app.core.config import ffmpeg_executable
from app.core.takes_config import TAKE_RATE
from tests._take_render_helpers import (
    BASE,
    client,
    render_isolation,
    start_render,
    take_folder,
    wait_render,
)
from tests._take_video_helpers import filmed_take, make_camera, video_track
from tests._takes_helpers import CAPTURE_RATE, JOB, SONG_SEC
from tests._video_helpers import fresh_encoders, needs_libx264

__all__ = ["client", "fresh_encoders", "render_isolation"]

pytestmark = [needs_libx264, pytest.mark.usefixtures("render_isolation")]

BACKING_HZ = 300
PLAYED_HZ = 1000
TAKE_HZ = 440
STEM_LEVEL = 0.6
TAKE_LEVEL = 0.9
TAKE_SEC = 3
# A tone left in would stand within a few dB of the backing's; leakage from
# the codec sits far below this share of it.
ABSENT_SHARE = 0.01
DECODE_TIMEOUT = 120
STEREO = 2
# The limiter holds the mix at -1 dBFS before encoding; AAC adds a little on
# top (0.2 dB measured here), which is what that headroom is for.
AAC_OVERSHOOT_DB = 0.5
DECODED_CEILING = EXPORT_CEILING * 10 ** (AAC_OVERSHOOT_DB / 20)


def _tone(hz: int, level: float, rate: int, seconds: float) -> np.ndarray:
    t = np.arange(int(rate * seconds)) / rate
    return (level * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def _write_stem(name: str, hz: int) -> None:
    tone = _tone(hz, STEM_LEVEL, TAKE_RATE, SONG_SEC)
    stems = cfg.JOBS_DIR / JOB / "stems"
    sf.write(str(stems / f"{name}.wav"), np.stack([tone, tone], axis=1), TAKE_RATE)


def _decoded(path) -> np.ndarray:
    """Both channels as decoded, without a downmix: ffmpeg's stereo to mono
    weights each side by about 0.7, which would add up past the ceiling."""
    cmd = [ffmpeg_executable(), "-nostdin", "-v", "error", "-i", str(path)]
    cmd += ["-map", "0:a", "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True, timeout=DECODE_TIMEOUT).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, STEREO)


def _level_at(samples: np.ndarray, rate: int, hz: int) -> float:
    spectrum = np.abs(np.fft.rfft(samples * np.hanning(len(samples))))
    return float(spectrum[round(hz * len(samples) / rate)])


def test_the_played_stem_is_left_out_and_the_peak_is_limited(client, tmp_path):
    _write_stem("drums", BACKING_HZ)
    _write_stem("guitar", PLAYED_HZ)
    take_audio = _tone(TAKE_HZ, TAKE_LEVEL, CAPTURE_RATE, TAKE_SEC).tobytes()
    camera = make_camera(tmp_path / "cam.webm")
    track = video_track(client, ["guitar"])
    take = filmed_take(client, track, camera, audio=take_audio)["id"]
    start_render(client, take, stems=["drums", "guitar"], gains=[1.0, 1.0])
    assert wait_render(client, take)["status"] == "done", client.get(f"{BASE}/takes").text
    channels = _decoded(take_folder(take) / "render.mp4")
    left = channels[:, 0]
    backing = _level_at(left, TAKE_RATE, BACKING_HZ)
    assert _level_at(left, TAKE_RATE, TAKE_HZ) > backing * ABSENT_SHARE
    assert _level_at(left, TAKE_RATE, PLAYED_HZ) < backing * ABSENT_SHARE
    assert float(np.max(np.abs(channels))) <= DECODED_CEILING
