"""Picture and sound of a filmed take's export line up within one frame
(#102, #99), with real ffmpeg on the CPU path.

Each case films a camera clip that is black but for a two-frame white flash, and
records a raw take that is silent but for one click, timed so that both are
the same physical instant under the case's placement, first-frame offset
and camera offset. The take's lane is rendered by #98's own code, the
export by the render command, and the flash and the click are found in the
MP4 the user would download.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import NamedTuple

import numpy as np
import pytest
import soundfile as sf

from app.api.takes_lanes import EXPORT_LIMITER
from app.core.config import ffmpeg_executable
from app.core.take_video import camera_start_sec, export_span
from app.core.takes import placement_sec
from app.core.takes_config import MS_PER_SEC, TAKE_RATE
from app.pipeline.take_render import render_take_audio
from app.pipeline.take_video_ffmpeg import run_render
from app.pipeline.take_video_render import AudioLane, RenderPlan, render_cmd
from app.pipeline.video_process import never
from tests._take_video_helpers import FLASH_SEC, flash_time, make_camera
from tests._video_helpers import needs_libx264

pytestmark = needs_libx264

RAW_RATE = 48000
RAW_SEC = 4.0
SONG_SEC = 6.0
CLICK_LEVEL = 0.9
OUT_W, OUT_H = 640, 360
RENDER_TIMEOUT = 120.0


class Case(NamedTuple):
    fps: int
    frame0: float
    camera_offset_ms: float = 0.0
    first_frame_offset_ms: float = 0.0
    trim: tuple[float, float] | None = None
    first_pts: float = 0.0
    suffix: str = ".webm"


CASES = {
    "24fps": Case(24, frame0=0.52),
    "count-in": Case(30, frame0=-1.0),
    "late-picture": Case(60, frame0=0.52, camera_offset_ms=80.0),
    "early-picture": Case(30, frame0=0.52, camera_offset_ms=-80.0),
    "trim-between-frames": Case(24, frame0=0.52, trim=(1.013, 3.5)),
    "first-pts-not-0-mp4": Case(30, frame0=0.52, first_pts=0.5, suffix=".mp4"),
    "negative-first-frame": Case(60, frame0=0.3, first_frame_offset_ms=-41.7),
}


def _sidecar(case: Case) -> dict:
    sidecar = {
        "timeline": {"frame0_song_sec": case.frame0},
        "latency": {"round_trip_ms": 20.0, "user_nudge_ms": 3.0},
        "duration_sec": RAW_SEC,
        "camera": {
            "first_frame_offset_ms": case.first_frame_offset_ms,
            "offset_ms": case.camera_offset_ms,
        },
    }
    sidecar["placement_sec"] = placement_sec(sidecar)
    if case.trim:
        sidecar["trim"] = {"in_sec": case.trim[0], "out_sec": case.trim[1]}
    return sidecar


def _click_sample(case: Case) -> int:
    """Where the click goes in the raw take, so it is the flash's instant: the
    flash is FLASH_SEC after the camera's first frame, which was taken
    first_frame_offset_ms after the first audio frame and seen camera_offset_ms late."""
    at = FLASH_SEC + (case.first_frame_offset_ms - case.camera_offset_ms) / MS_PER_SEC
    return round(at * RAW_RATE)


def _take_wav(tmp: Path, case: Case, sidecar: dict) -> Path:
    raw = np.zeros(int(RAW_SEC * RAW_RATE), dtype=np.float32)
    raw[_click_sample(case)] = CLICK_LEVEL
    sf.write(str(tmp / "raw.wav"), raw, RAW_RATE, subtype="FLOAT")
    wav = tmp / "audio.wav"
    frames = int(SONG_SEC * TAKE_RATE)
    render_take_audio(tmp / "raw.wav", wav, sidecar["placement_sec"], frames, RAW_RATE, 1)
    return wav


def _plan(tmp: Path, case: Case, sidecar: dict) -> RenderPlan:
    start, end = export_span(sidecar, SONG_SEC)
    return RenderPlan(
        camera=make_camera(tmp / f"cam{case.suffix}", first_pts_sec=case.first_pts),
        camera_start_sec=camera_start_sec(sidecar),
        mirror=False,
        lanes=(AudioLane(_take_wav(tmp, case, sidecar), 1.0),),
        start_sec=start,
        duration_sec=end - start,
        width=OUT_W,
        height=OUT_H,
        fps=case.fps,
        sample_rate=TAKE_RATE,
        limiter=EXPORT_LIMITER,
    )


def click_time(path: Path, rate: int) -> float:
    """The loudest sample of the decoded sound, in seconds; the decoder drops
    the AAC priming, so 0 is the file's start."""
    cmd = [ffmpeg_executable(), "-nostdin", "-v", "error", "-i", str(path)]
    cmd += ["-map", "0:a", "-ac", "1", "-f", "f32le", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True, timeout=RENDER_TIMEOUT).stdout
    return int(np.argmax(np.abs(np.frombuffer(raw, dtype=np.float32)))) / rate


@pytest.mark.parametrize("case", CASES.values(), ids=CASES.keys())
def test_flash_and_click_land_within_one_frame(tmp_path, case):
    plan = _plan(tmp_path, case, _sidecar(case))
    out = tmp_path / "out.mp4"
    run_render(render_cmd(plan, out, "libx264"), RENDER_TIMEOUT, None, never, lambda _t: None)
    flash = flash_time(out)
    click = click_time(out, plan.sample_rate)
    assert flash is not None, "the flash frame is missing from the export"
    assert abs(flash - click) <= 1 / case.fps, f"flash {flash:.4f} s, click {click:.4f} s"
