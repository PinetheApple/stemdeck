"""The output check, on real files made by the local ffmpeg (libx264)."""

from __future__ import annotations

import pytest

from app.pipeline.video_validate import OutputInvalid, validate_output
from tests._video_helpers import TINY_FPS, TINY_H, TINY_SEC, TINY_W, make_mp4, needs_libx264

pytestmark = needs_libx264


@pytest.fixture(scope="module")
def good_mp4(tmp_path_factory):
    return make_mp4(tmp_path_factory.mktemp("video") / "good.mp4")


def _code(path, **over) -> str:
    want = {"width": TINY_W, "height": TINY_H, "fps": TINY_FPS, "duration_sec": TINY_SEC}
    want.update(over)
    with pytest.raises(OutputInvalid) as caught:
        validate_output(path, **want)
    return caught.value.code


def test_a_good_file_passes(good_mp4):
    validate_output(good_mp4, TINY_W, TINY_H, TINY_FPS, TINY_SEC)


def test_wrong_size_fps_and_length_are_named(good_mp4):
    assert _code(good_mp4, width=640) == "size"
    assert _code(good_mp4, fps=60) == "fps"
    assert _code(good_mp4, duration_sec=TINY_SEC + 3) == "duration"


def test_a_file_without_audio_fails(tmp_path):
    assert _code(make_mp4(tmp_path / "mute.mp4", audio=False)) == "audio"


def test_missing_and_tiny_files_fail(tmp_path):
    assert _code(tmp_path / "absent.mp4") == "missing"
    stub = tmp_path / "stub.mp4"
    stub.write_bytes(b"\0" * 100)
    assert _code(stub) == "filesize"


def test_a_truncated_file_fails(good_mp4, tmp_path):
    cut = tmp_path / "cut.mp4"
    data = good_mp4.read_bytes()
    cut.write_bytes(data[: len(data) * 2 // 3])
    assert _code(cut) in {"probe", "decode", "duration"}


def test_a_cancel_stops_the_check(good_mp4):
    assert _code(good_mp4, cancelled=lambda: True) == "cancelled"
