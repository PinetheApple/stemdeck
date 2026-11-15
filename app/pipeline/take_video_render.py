"""The ffmpeg command that renders a filmed take to MP4 (#102, #99).

The picture is the camera file shifted onto the song clock, cut to the
export span, snapped to the output frame rate and letterboxed into a 16:9
canvas. The sound is the backing (the export mix without the "I play" stems)
plus the take, through the export limiter.

Sync: the camera's frame 0 sits at `camera_start_sec` on the song clock
(app.core.take_video.camera_start_sec). Its timestamps are moved there
first and cut after; the other order measured a 25 ms error upstream. The
fps filter then puts each frame on the nearest output frame, so the server
adds at most half a frame of error. Every audio lane starts at the span's
first whole 44.1 kHz sample.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.core.config import ffmpeg_executable
from app.core.take_video_config import AUDIO_BITRATE
from app.core.takes_config import TAKE_RATE
from app.core.video_config import AUDIO_CODEC
from app.pipeline.video_encoder_args import encoder_args, global_args, output_filter

MIX_LABEL = "[mix]"
VIDEO_LABEL = "[v]"
_CANVAS_COLOR = "black"


@dataclass(frozen=True)
class AudioLane:
    """One audio input; `pitch_stage` is its transpose filter with a trailing
    comma, or "" (the export's own, app.api.stems._pitch_filter)."""

    path: Path
    gain: float
    pitch_stage: str = ""


@dataclass(frozen=True)
class RenderPlan:
    """Everything one render needs; the take's own lane is the last one."""

    camera: Path
    camera_start_sec: float
    mirror: bool
    lanes: tuple[AudioLane, ...]
    start_sec: float
    duration_sec: float
    width: int
    height: int
    fps: int
    sample_rate: int
    limiter: str


def span_samples(start_sec: float, duration_sec: float) -> tuple[int, int]:
    """The span as whole samples of the stems' rate: [first, end)."""
    first = round(start_sec * TAKE_RATE)
    return first, first + round(duration_sec * TAKE_RATE)


def picture_shift_sec(plan: RenderPlan) -> float:
    """Where the camera's frame 0 lands on the output's clock."""
    return plan.camera_start_sec - plan.start_sec


def camera_chain(plan: RenderPlan, index: int) -> str:
    """Shift, then cut what falls before the span, then the output rate,
    the mirror and the letterbox."""
    shift = picture_shift_sec(plan)
    steps = [f"[{index}:v]setpts=PTS-STARTPTS+({shift:.6f})/TB"]
    if shift < 0:
        steps.append("trim=start=0")
    steps.append(f"fps={plan.fps}")
    if plan.mirror:
        steps.append("hflip")
    steps.append(f"scale={plan.width}:{plan.height}:force_original_aspect_ratio=decrease")
    steps.append("setsar=1[cam]")
    return ",".join(steps)


def picture_filters(plan: RenderPlan, index: int, encoder: str) -> list[str]:
    """The camera over a black canvas of the span's length, in the encoder's format."""
    canvas = (
        f"color={_CANVAS_COLOR}:s={plan.width}x{plan.height}:r={plan.fps}"
        f":d={plan.duration_sec:.6f}[bg]"
    )
    overlay = (
        "[bg][cam]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass,"
        f"{output_filter(encoder)}{VIDEO_LABEL}"
    )
    return [canvas, camera_chain(plan, index), overlay]


def audio_filters(plan: RenderPlan) -> list[str]:
    """Each lane cut to the span at its gain and shift, summed without
    normalising, then the export limiter: a take is always in this mix."""
    first, end = span_samples(plan.start_sec, plan.duration_sec)
    filters = [
        f"[{i}:a]atrim=start_sample={first}:end_sample={end},asetpts=PTS-STARTPTS,"
        f"{lane.pitch_stage}volume={lane.gain:.6f}[a{i}]"
        for i, lane in enumerate(plan.lanes)
    ]
    labels = "".join(f"[a{i}]" for i in range(len(plan.lanes)))
    count = len(plan.lanes)
    summed = f"amix=inputs={count}:normalize=0," if count > 1 else ""
    filters.append(f"{labels}{summed}{plan.limiter}{MIX_LABEL}")
    return filters


def render_cmd(
    plan: RenderPlan,
    dest: Path,
    encoder: str,
    variant: int = 0,
    device: str = "",
) -> list[str]:
    """The full command, writing `dest` as MP4 and its progress to stdout."""
    cmd = [ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-nostats"]
    cmd += ["-progress", "pipe:1", *global_args(encoder, device)]
    for lane in plan.lanes:
        cmd += ["-i", str(lane.path)]
    cmd += ["-i", str(plan.camera)]
    graph = [*audio_filters(plan), *picture_filters(plan, len(plan.lanes), encoder)]
    cmd += ["-filter_complex", ";".join(graph), "-map", VIDEO_LABEL, "-map", MIX_LABEL]
    cmd += encoder_args(encoder, plan.width, plan.height, plan.fps, variant)
    cmd += ["-c:a", AUDIO_CODEC, "-b:a", AUDIO_BITRATE, "-ar", str(plan.sample_rate)]
    cmd += ["-t", f"{plan.duration_sec:.6f}", "-movflags", "+faststart"]
    return [*cmd, "-f", "mp4", "-y", str(dest)]
