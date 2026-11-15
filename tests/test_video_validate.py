"""The output checks, on real files made by the local ffmpeg (libx264)."""

from __future__ import annotations

import pytest

from app.pipeline import video_validate
from app.pipeline.video_process import STOP_CANCELLED
from app.pipeline.video_validate import (
    CHECK_AUDIO,
    CHECK_DURATION,
    CHECK_FILESIZE,
    CHECK_FPS,
    CHECK_MISSING,
    CHECK_SIZE,
    CHECK_UNIFORM,
    OutputInvalid,
    check_moving_picture,
    short_of_disk,
    validate_output,
)
from tests._video_helpers import TINY_FPS, TINY_H, TINY_SEC, TINY_W, make_mp4, needs_libx264


@pytest.fixture(scope="module")
def good_mp4(tmp_path_factory):
    return make_mp4(tmp_path_factory.mktemp("video") / "good.mp4")


def _code(path, **over) -> str:
    want = {"width": TINY_W, "height": TINY_H, "fps": TINY_FPS, "duration_sec": TINY_SEC}
    want.update(over)
    with pytest.raises(OutputInvalid) as caught:
        validate_output(path, **want)
    return caught.value.code


@needs_libx264
def test_a_good_file_passes(good_mp4):
    validate_output(good_mp4, TINY_W, TINY_H, TINY_FPS, TINY_SEC)
    check_moving_picture(good_mp4, TINY_SEC)


@needs_libx264
def test_wrong_size_fps_and_length_are_named(good_mp4):
    assert _code(good_mp4, width=640) == CHECK_SIZE
    assert _code(good_mp4, fps=60) == CHECK_FPS
    assert _code(good_mp4, duration_sec=TINY_SEC + 3) == CHECK_DURATION


@needs_libx264
def test_a_file_without_audio_fails(tmp_path):
    assert _code(make_mp4(tmp_path / "mute.mp4", audio=False)) == CHECK_AUDIO


def test_missing_and_tiny_files_fail(tmp_path):
    assert _code(tmp_path / "absent.mp4") == CHECK_MISSING
    stub = tmp_path / "stub.mp4"
    stub.write_bytes(b"\0" * 100)
    assert _code(stub) == CHECK_FILESIZE


@needs_libx264
def test_a_truncated_file_fails(good_mp4, tmp_path):
    cut = tmp_path / "cut.mp4"
    data = good_mp4.read_bytes()
    cut.write_bytes(data[: len(data) * 2 // 3])
    assert _code(cut) in {"probe", "decode", CHECK_DURATION}


@needs_libx264
def test_a_cancel_stops_the_check(good_mp4):
    assert _code(good_mp4, cancelled=lambda: True) == STOP_CANCELLED


@needs_libx264
def test_a_clean_file_of_one_solid_colour_is_refused(tmp_path):
    solid = make_mp4(tmp_path / "solid.mp4", source="color", source_options="c=green")
    validate_output(solid, TINY_W, TINY_H, TINY_FPS, TINY_SEC)
    with pytest.raises(OutputInvalid) as caught:
        check_moving_picture(solid, TINY_SEC)
    assert caught.value.code == CHECK_UNIFORM


def test_short_of_disk_reads_the_free_space(monkeypatch, tmp_path):
    usage = type("Usage", (), {"free": 0})
    monkeypatch.setattr(video_validate.shutil, "disk_usage", lambda path: usage)
    assert short_of_disk(tmp_path / "x.mp4")
    usage.free = 10**12
    assert not short_of_disk(tmp_path / "x.mp4")
