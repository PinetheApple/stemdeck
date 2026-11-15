"""The test encode, its classification and the probe cache. ffmpeg is mocked
except in the libx264 probe, which runs the real binary when it is there."""

from __future__ import annotations

import json

import pytest

from app.core.video_config import (
    NVENC,
    VAAPI,
    VIDEO_CPU_ENCODER,
    VIDEO_ENCODER_FAIL_TTL_SEC,
    VIDEO_ENCODER_PASS_TTL_SEC,
    VIDEO_ENCODER_RETRY_SEC,
)
from app.pipeline import video_probe
from app.pipeline.video_validate import OutputInvalid, ProcessStopped
from tests._video_helpers import TINY_FPS, TINY_H, TINY_W, fresh_encoders, needs_libx264

__all__ = ["fresh_encoders"]

# What h264_nvenc printed in the agent sandbox, which hides the GPU.
NO_CUDA_STDERR = (
    "[h264_nvenc @ 0x560d1b47ba00] dl_fn->cuda_dl->cuInit(0) failed -> "
    "CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected\n"
    "[vost#0:0/h264_nvenc @ 0x560d1b47b340] [enc:h264_nvenc @ 0x560d1b47b980] Error while "
    "opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.\n"
)
NO_VA_STDERR = "[VAAPI @ 0x5556937a49c0] No VA display found for device /dev/dri/renderD129.\n"


def _fake_run(monkeypatch, rc=0, stderr="", calls=None):
    def run(cmd, timeout, cancelled):
        if calls is not None:
            calls.append(cmd)
        return rc, "", stderr

    monkeypatch.setattr(video_probe, "run_watched", run)


def _valid(monkeypatch, error: OutputInvalid | None = None):
    def check(path, width, height, fps, duration_sec, cancelled):
        if error is not None:
            raise error

    monkeypatch.setattr(video_probe, "validate_output", check)


@pytest.mark.usefixtures("fresh_encoders")
def test_a_clean_exit_with_a_valid_file_passes(monkeypatch):
    _fake_run(monkeypatch)
    _valid(monkeypatch)
    result = video_probe.run_probe(NVENC, 1280, 720, 30)
    assert result.ok and result.reason == ""


@pytest.mark.usefixtures("fresh_encoders")
def test_a_clean_exit_with_a_bad_file_fails(monkeypatch):
    _fake_run(monkeypatch)
    _valid(monkeypatch, OutputInvalid("fps"))
    result = video_probe.run_probe(NVENC, 1280, 720, 30)
    assert not result.ok and result.reason == "invalid-fps" and not result.transient


@pytest.mark.parametrize(
    ("stderr", "reason", "transient"),
    [
        (NO_CUDA_STDERR, "no-device", False),
        (NO_VA_STDERR, "no-device", False),
        ("Unknown encoder 'h264_qsv'", "missing", False),
        ("[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory", "busy", True),
        ("[h264_amf @ 0x1] something odd", "failed", False),
    ],
)
def test_failures_are_classified(stderr, reason, transient):
    assert video_probe.classify_failure(stderr) == (reason, transient)


@pytest.mark.usefixtures("fresh_encoders")
def test_the_real_no_device_error_reads_plainly(monkeypatch):
    _fake_run(monkeypatch, rc=1, stderr=NO_CUDA_STDERR)
    result = video_probe.run_probe(NVENC, 1280, 720, 30)
    assert result.reason == "no-device"
    assert "0x" not in result.detail and "CUDA_ERROR_NO_DEVICE" in result.detail


@pytest.mark.usefixtures("fresh_encoders")
def test_nvenc_tries_its_second_argument_set(monkeypatch):
    calls: list[list[str]] = []
    _fake_run(monkeypatch, rc=1, stderr="[h264_nvenc @ 0x1] Invalid preset", calls=calls)
    video_probe.run_probe(NVENC, 1280, 720, 30)
    assert len(calls) == 2 and "slow" in calls[1]


@pytest.mark.usefixtures("fresh_encoders")
def test_a_timeout_is_transient(monkeypatch):
    def run(cmd, timeout, cancelled):
        raise ProcessStopped("timeout")

    monkeypatch.setattr(video_probe, "run_watched", run)
    result = video_probe.run_probe(VAAPI, 1280, 720, 30, device="/dev/dri/renderD129")
    assert result.reason == "timeout" and result.transient


@pytest.mark.parametrize(
    ("ok", "transient", "ttl"),
    [
        (True, False, VIDEO_ENCODER_PASS_TTL_SEC),
        (False, False, VIDEO_ENCODER_FAIL_TTL_SEC),
        (False, True, VIDEO_ENCODER_RETRY_SEC),
    ],
)
def test_each_result_lasts_its_own_time(ok, transient, ttl):
    result = video_probe.ProbeResult(NVENC, 1, 1, 30, ok=ok, transient=transient, checked_at=100.0)
    assert result.expires_at() == 100.0 + ttl


def _counting_probe(monkeypatch, ok=True):
    calls: list[str] = []

    def run_probe(encoder, width, height, fps, device="", cancelled=None):
        calls.append(device)
        return video_probe.ProbeResult(
            encoder,
            width,
            height,
            fps,
            ok=ok,
            device=device,
            checked_at=video_probe.now(),
        )

    monkeypatch.setattr(video_probe, "run_probe", run_probe)
    monkeypatch.setattr(video_probe, "ffmpeg_identity", lambda: ("ident-a", "ffmpeg version x"))
    return calls


def test_a_pass_is_cached_on_disk_and_reused(monkeypatch, fresh_encoders):
    calls = _counting_probe(monkeypatch)
    assert video_probe.probe(NVENC, 1280, 720, 30).ok
    assert video_probe.probe(NVENC, 1280, 720, 30).ok
    assert len(calls) == 1
    saved = json.loads((fresh_encoders / "video_encoders.json").read_text())
    assert saved["ffmpeg"] == "ident-a" and len(saved["results"]) == 1
    video_probe.reset_cache()
    assert video_probe.probe(NVENC, 1280, 720, 30).ok
    assert len(calls) == 1


@pytest.mark.usefixtures("fresh_encoders")
def test_another_geometry_or_force_probes_again(monkeypatch):
    calls = _counting_probe(monkeypatch)
    video_probe.probe(NVENC, 1280, 720, 30)
    video_probe.probe(NVENC, 1920, 1080, 60)
    video_probe.probe(NVENC, 1280, 720, 30, force=True)
    assert len(calls) == 3


@pytest.mark.usefixtures("fresh_encoders")
def test_a_new_ffmpeg_forgets_every_result(monkeypatch):
    calls = _counting_probe(monkeypatch)
    video_probe.probe(NVENC, 1280, 720, 30)
    monkeypatch.setattr(video_probe, "ffmpeg_identity", lambda: ("ident-b", "ffmpeg version y"))
    video_probe.probe(NVENC, 1280, 720, 30)
    assert len(calls) == 2


@pytest.mark.usefixtures("fresh_encoders")
def test_an_expired_result_is_probed_again(monkeypatch):
    calls = _counting_probe(monkeypatch, ok=False)
    video_probe.probe(NVENC, 1280, 720, 30)
    later = video_probe.now() + VIDEO_ENCODER_FAIL_TTL_SEC + 1
    monkeypatch.setattr(video_probe, "now", lambda: later)
    video_probe.probe(NVENC, 1280, 720, 30)
    assert len(calls) == 2


@pytest.mark.usefixtures("fresh_encoders")
def test_a_node_now_on_another_gpu_is_probed_again(monkeypatch):
    calls = _counting_probe(monkeypatch)
    node = "/dev/dri/renderD128"
    monkeypatch.setattr(video_probe, "gpu_id", lambda device: "1002:1900")
    video_probe.probe(VAAPI, 1280, 720, 30, device=node)
    monkeypatch.setattr(video_probe, "gpu_id", lambda device: "10de:2dd8")
    video_probe.probe(VAAPI, 1280, 720, 30, device=node)
    assert calls == [node, node]


@pytest.mark.usefixtures("fresh_encoders")
def test_dropping_passes_forgets_only_that_encoder(monkeypatch):
    calls = _counting_probe(monkeypatch)
    video_probe.probe(NVENC, 1280, 720, 30)
    video_probe.probe(VAAPI, 1280, 720, 30, device="/dev/dri/renderD129")
    video_probe.drop_passes(NVENC)
    video_probe.probe(NVENC, 1280, 720, 30)
    video_probe.probe(VAAPI, 1280, 720, 30, device="/dev/dri/renderD129")
    assert len(calls) == 3


def test_a_corrupt_cache_file_is_ignored(monkeypatch, fresh_encoders):
    (fresh_encoders / "video_encoders.json").write_text("{not json")
    calls = _counting_probe(monkeypatch)
    assert video_probe.probe(NVENC, 1280, 720, 30).ok and len(calls) == 1


@needs_libx264
@pytest.mark.usefixtures("fresh_encoders")
def test_a_real_libx264_test_encode_passes_its_check():
    result = video_probe.run_probe(VIDEO_CPU_ENCODER, TINY_W, TINY_H, TINY_FPS)
    assert result.ok, result.detail
    assert result.speed is not None and result.speed > 0
