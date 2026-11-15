"""The filmed-take render's pure parts (#102, #99): the picture's start on
the song clock, the export span, the command, and the backing without the
"I play" stems. No ffmpeg runs here."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.api.takes_video_iplay import Lane, without_played
from app.core.take_video import camera_start_sec, export_span, take_span
from app.pipeline.take_video_render import AudioLane, RenderPlan, camera_chain, render_cmd

PLACED = {"placement_sec": 2.0, "duration_sec": 10.0}
LIMITER = "alimiter=limit=0.9"


def _plan(**over) -> RenderPlan:
    fields = {
        "camera": Path("cam.webm"),
        "camera_start_sec": 1.5,
        "mirror": False,
        "lanes": (
            AudioLane(Path("drums.wav"), 0.5, "rubberband=pitch=2,"),
            AudioLane(Path("t.wav"), 1.0),
        ),
        "start_sec": 2.0,
        "duration_sec": 4.0,
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "sample_rate": 48000,
        "limiter": LIMITER,
    }
    return RenderPlan(**{**fields, **over})


def test_camera_start_follows_placement_first_frame_and_offset():
    sidecar = {**PLACED, "camera": {"first_frame_offset_ms": -40.0, "offset_ms": 60.0}}
    assert camera_start_sec(sidecar) == pytest.approx(2.0 - 0.04 - 0.06)


def test_span_is_clamped_to_the_song_and_trimmed():
    assert take_span({"placement_sec": -1.0, "duration_sec": 10.0}, 6.0) == (0.0, 6.0)
    trimmed = {**PLACED, "trim": {"in_sec": 1.0, "out_sec": 5.0}}
    assert export_span(trimmed, 60.0) == (2.0, 5.0)


def test_picture_is_shifted_before_it_is_cut():
    late = camera_chain(_plan(camera_start_sec=2.5), 2)
    assert late.startswith("[2:v]setpts=PTS-STARTPTS+(0.500000)/TB,fps=30")
    early = camera_chain(_plan(), 2)
    assert early.index("setpts=PTS-STARTPTS+(-0.500000)/TB") < early.index("trim=start=0")
    assert "hflip" in camera_chain(_plan(mirror=True), 2)


def test_golden_libx264_command():
    cmd = render_cmd(_plan(), Path("out.tmp"), "libx264")
    graph = cmd[cmd.index("-filter_complex") + 1].split(";")
    assert graph[0] == (
        "[0:a]atrim=start_sample=88200:end_sample=264600,asetpts=PTS-STARTPTS,"
        "rubberband=pitch=2,volume=0.500000[a0]"
    )
    assert graph[2] == f"[a0][a1]amix=inputs=2:normalize=0,{LIMITER}[mix]"
    assert graph[3] == "color=black:s=1920x1080:r=30:d=4.000000[bg]"
    assert graph[-1].endswith("eof_action=pass,format=yuv420p[v]")
    tail = cmd[cmd.index("-map") :]
    assert tail == [
        *("-map", "[v]", "-map", "[mix]"),
        *("-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p"),
        *("-c:a", "aac", "-b:a", "192k", "-ar", "48000"),
        *("-t", "4.000000", "-movflags", "+faststart", "-f", "mp4", "-y", "out.tmp"),
    ]
    assert cmd[cmd.index("-progress") + 1] == "pipe:1"


def _exists(*names: str):
    return lambda name: name in names


ALL = _exists(
    "vocals", "drums", "bass", "guitar", "piano", "other", "lead_vocals", "backing_vocals"
)


def test_a_played_lane_is_dropped():
    lanes = [Lane("drums", 1.0, 0), Lane("guitar", 0.8, 2), Lane("t1234abcd", 1.0, 0)]
    assert without_played(lanes, ["guitar"], ALL) == [lanes[0], lanes[2]]


def test_vocals_implies_its_halves_and_a_half_keeps_the_other():
    halves = [Lane("lead_vocals", 1.0, 0), Lane("backing_vocals", 0.7, 0)]
    assert without_played(halves, ["vocals"], ALL) == []
    assert without_played([Lane("vocals", 0.9, 1)], ["lead_vocals"], ALL) == [
        Lane("backing_vocals", 0.9, 1)
    ]


def test_original_is_rebuilt_without_the_played_stem():
    lanes = [Lane("vocals", 1.0, 0), Lane("original", 0.5, 2)]
    rebuilt = without_played(lanes, ["guitar"], ALL)
    assert rebuilt == [
        Lane("vocals", 1.0, 0),
        Lane("drums", 0.5, 0),
        Lane("bass", 0.5, 2),
        Lane("piano", 0.5, 2),
        Lane("other", 0.5, 2),
    ]


def test_original_untouched_by_i_play_stays_one_lane():
    lanes = [Lane("guitar", 1.0, 0), Lane("original", 0.5, 0)]
    assert without_played(lanes, ["guitar"], ALL) == [Lane("original", 0.5, 0)]


def test_original_that_cannot_be_rebuilt_is_422():
    with pytest.raises(HTTPException) as exc:
        without_played([Lane("original", 1.0, 0)], ["guitar"], _exists("drums"))
    assert exc.value.status_code == 422
