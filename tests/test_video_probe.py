"""The test encode, its classification and the probe cache. ffmpeg is mocked
except in the libx264 probe, which runs the real binary when it is there."""

from __future__ import annotations

import json
import threading

import pytest

from app.core.video_config import (
    NVENC,
    VAAPI,
    VIDEO_CPU_ENCODER,
    VIDEO_ENCODER_CACHE_FILE,
    VIDEO_ENCODER_FAIL_TTL_SEC,
    VIDEO_ENCODER_PASS_TTL_SEC,
    VIDEO_ENCODER_RETRY_SEC,
)
from app.pipeline import video_probe, video_probe_store
from app.pipeline.video_probe import REASON_FILES, ProbeResult, ProbeTarget
from app.pipeline.video_process import STOP_CANCELLED, STOP_TIMEOUT, ProcessStopped
from app.pipeline.video_validate import CHECK_FILESIZE, CHECK_FPS, CHECK_UNIFORM, OutputInvalid
from tests._video_helpers import TINY_FPS, TINY_H, TINY_W, fresh_encoders, needs_libx264

__all__ = ["fresh_encoders"]

# What h264_nvenc and VAAPI print on a machine whose GPU they cannot open.
NO_CUDA_STDERR = (
    "[h264_nvenc @ 0x560d1b47ba00] dl_fn->cuda_dl->cuInit(0) failed -> "
    "CUDA_ERROR_NO_DEVICE: no CUDA-capable device is detected\n"
    "[vost#0:0/h264_nvenc @ 0x560d1b47b340] [enc:h264_nvenc @ 0x560d1b47b980] Error while "
    "opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.\n"
)
NO_VA_STDERR = "[VAAPI @ 0x5556937a49c0] No VA display found for device /dev/dri/renderD129.\n"
DISK_FULL_STDERR = "[out#0/mp4 @ 0x1] Error writing trailer: No space left on device\n"
DRM_DENIED_STDERR = (
    "[AVHWDeviceContext @ 0x1] Failed to open the DRM device /dev/dri/renderD128: "
    "Permission denied\nDevice creation failed: -13.\n"
)
DRM_MISSING_STDERR = (
    "[AVHWDeviceContext @ 0x1] Failed to open the DRM device /dev/dri/renderD200: "
    "No such file or directory\nDevice creation failed: -2.\n"
)
ENOSPC_STDERR = (
    "[mp4 @ 0x1] Error writing packet: No space left on device\n"
    "[out#0/mp4 @ 0x2] Error muxing a packet\n"
)
NO_OUTPUT_DIR_STDERR = (
    "[out#0/mp4 @ 0x1] Error opening output /missing/dir/probe.mp4: No such file or directory\n"
)


def _fake_run(monkeypatch, rc=0, stderr="", calls=None):
    def run(cmd, timeout, cancelled):
        if calls is not None:
            calls.append(cmd)
        return rc, "", stderr

    monkeypatch.setattr(video_probe, "run_watched", run)


def _checks(monkeypatch, error: OutputInvalid | None = None, moving: OutputInvalid | None = None):
    def check(path, width, height, fps, duration_sec, cancelled):
        if error is not None:
            raise error

    def check_moving(path, duration_sec, cancelled):
        if moving is not None:
            raise moving

    monkeypatch.setattr(video_probe, "validate_output", check)
    monkeypatch.setattr(video_probe, "check_moving_picture", check_moving)


@pytest.mark.usefixtures("fresh_encoders")
def test_a_clean_exit_with_a_good_file_passes(monkeypatch):
    _fake_run(monkeypatch)
    _checks(monkeypatch)
    result = video_probe.run_probe(NVENC, 1280, 720, 30)
    assert result.ok and result.reason == ""


@pytest.mark.usefixtures("fresh_encoders")
def test_a_clean_exit_with_a_bad_file_fails(monkeypatch):
    _fake_run(monkeypatch)
    _checks(monkeypatch, OutputInvalid(CHECK_FPS))
    result = video_probe.run_probe(NVENC, 1280, 720, 30)
    assert not result.ok and result.reason == "invalid-fps" and not result.transient


@pytest.mark.usefixtures("fresh_encoders")
def test_a_clean_file_of_one_colour_fails(monkeypatch):
    _fake_run(monkeypatch)
    _checks(monkeypatch, moving=OutputInvalid(CHECK_UNIFORM))
    result = video_probe.run_probe(NVENC, 1280, 720, 30)
    assert result.reason == "invalid-uniform" and not result.transient


@pytest.mark.parametrize(
    ("stderr", "reason", "transient"),
    [
        (NO_CUDA_STDERR, "no-device", False),
        (NO_VA_STDERR, "no-device", False),
        (DISK_FULL_STDERR, REASON_FILES, True),
        (DRM_DENIED_STDERR, "no-device", False),
        (DRM_MISSING_STDERR, "no-device", False),
        ("[h264_nvenc @ 0x1] cuInit(0) failed -> CUDA_ERROR_NO_DEVICE", "no-device", False),
        (ENOSPC_STDERR, REASON_FILES, True),
        (NO_OUTPUT_DIR_STDERR, REASON_FILES, True),
        ("Unknown encoder 'h264_qsv'", "missing", False),
        ("[h264_nvenc @ 0x1] OpenEncodeSessionEx failed: out of memory", "busy", True),
        ("[h264_amf @ 0x1] something odd", "failed", False),
    ],
)
def test_failures_are_classified(stderr, reason, transient):
    assert video_probe.classify_failure(stderr) == (reason, transient)


@pytest.mark.usefixtures("fresh_encoders")
def test_the_no_device_error_reads_plainly(monkeypatch):
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
        raise ProcessStopped(STOP_TIMEOUT)

    monkeypatch.setattr(video_probe, "run_watched", run)
    result = video_probe.run_probe(VAAPI, 1280, 720, 30, device="/dev/dri/renderD129")
    assert result.reason == STOP_TIMEOUT and result.transient


@pytest.mark.parametrize(
    ("ok", "transient", "ttl"),
    [
        (True, False, VIDEO_ENCODER_PASS_TTL_SEC),
        (False, False, VIDEO_ENCODER_FAIL_TTL_SEC),
        (False, True, VIDEO_ENCODER_RETRY_SEC),
    ],
)
def test_each_result_lasts_its_own_time(ok, transient, ttl):
    result = ProbeResult(NVENC, 1, 1, 30, ok=ok, transient=transient, checked_at=100.0)
    assert result.expires_at() == 100.0 + ttl


def _counting_probe(monkeypatch, ok=True, reason=""):
    calls: list[str] = []

    def run_probe(encoder, width, height, fps, device="", cancelled=None):
        calls.append(device)
        target = ProbeTarget(encoder, width, height, fps, device=device)
        return target.result(ok, reason=reason)

    monkeypatch.setattr(video_probe, "run_probe", run_probe)
    monkeypatch.setattr(video_probe_store, "ffmpeg_identity", lambda: "ident-a")
    return calls


def test_a_pass_is_cached_on_disk_and_reused(monkeypatch, fresh_encoders):
    calls = _counting_probe(monkeypatch)
    assert video_probe.probe(NVENC, 1280, 720, 30).ok
    assert video_probe.probe(NVENC, 1280, 720, 30).ok
    assert len(calls) == 1
    saved = json.loads((fresh_encoders / VIDEO_ENCODER_CACHE_FILE).read_text())
    assert saved["ffmpeg"] == "ident-a" and len(saved["results"]) == 1
    video_probe_store.reset_cache()
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
    monkeypatch.setattr(video_probe_store, "ffmpeg_identity", lambda: "ident-b")
    video_probe.probe(NVENC, 1280, 720, 30)
    assert len(calls) == 2


@pytest.mark.usefixtures("fresh_encoders")
def test_an_expired_result_is_probed_again(monkeypatch):
    calls = _counting_probe(monkeypatch, ok=False)
    video_probe.probe(NVENC, 1280, 720, 30)
    later = video_probe_store.now() + VIDEO_ENCODER_FAIL_TTL_SEC + 1
    monkeypatch.setattr(video_probe_store, "now", lambda: later)
    video_probe.probe(NVENC, 1280, 720, 30)
    assert len(calls) == 2


@pytest.mark.usefixtures("fresh_encoders")
def test_a_node_now_on_another_gpu_is_probed_again(monkeypatch):
    calls = _counting_probe(monkeypatch)
    node = "/dev/dri/renderD128"
    monkeypatch.setattr(video_probe_store, "gpu_id", lambda device: "1002:1900")
    video_probe.probe(VAAPI, 1280, 720, 30, device=node)
    monkeypatch.setattr(video_probe_store, "gpu_id", lambda device: "10de:2dd8")
    video_probe.probe(VAAPI, 1280, 720, 30, device=node)
    assert calls == [node, node]


@pytest.mark.usefixtures("fresh_encoders")
def test_dropping_passes_forgets_only_that_encoder(monkeypatch):
    calls = _counting_probe(monkeypatch)
    video_probe.probe(NVENC, 1280, 720, 30)
    video_probe.probe(VAAPI, 1280, 720, 30, device="/dev/dri/renderD129")
    video_probe_store.drop_passes(NVENC)
    video_probe.probe(NVENC, 1280, 720, 30)
    video_probe.probe(VAAPI, 1280, 720, 30, device="/dev/dri/renderD129")
    assert len(calls) == 3


def test_a_corrupt_cache_file_is_ignored(monkeypatch, fresh_encoders):
    (fresh_encoders / VIDEO_ENCODER_CACHE_FILE).write_text("{not json")
    calls = _counting_probe(monkeypatch)
    assert video_probe.probe(NVENC, 1280, 720, 30).ok and len(calls) == 1


def test_a_full_disk_during_a_probe_is_never_cached(monkeypatch, fresh_encoders):
    _fake_run(monkeypatch, rc=1, stderr=DISK_FULL_STDERR)
    monkeypatch.setattr(video_probe_store, "ffmpeg_identity", lambda: "ident-a")
    first = video_probe.probe(NVENC, 1280, 720, 30)
    assert first.reason == REASON_FILES and first.transient
    assert not (fresh_encoders / VIDEO_ENCODER_CACHE_FILE).exists()
    _fake_run(monkeypatch)
    _checks(monkeypatch)
    assert video_probe.probe(NVENC, 1280, 720, 30).ok


@pytest.mark.usefixtures("fresh_encoders")
def test_a_short_file_on_a_full_disk_is_the_disks_fault(monkeypatch):
    _fake_run(monkeypatch)
    _checks(monkeypatch, OutputInvalid(CHECK_FILESIZE))
    monkeypatch.setattr(video_probe, "short_of_disk", lambda path: True)
    assert video_probe.run_probe(NVENC, 1280, 720, 30).reason == REASON_FILES
    monkeypatch.setattr(video_probe, "short_of_disk", lambda path: False)
    assert video_probe.run_probe(NVENC, 1280, 720, 30).reason == "invalid-filesize"


@pytest.mark.usefixtures("fresh_encoders")
def test_a_render_waiting_for_the_probe_lock_can_be_cancelled(monkeypatch):
    calls = _counting_probe(monkeypatch)
    stop = threading.Event()
    got: list[ProbeResult] = []
    with video_probe._probe_lock:
        waiter = threading.Thread(
            target=lambda: got.append(
                video_probe.probe(NVENC, 1280, 720, 30, cancelled=stop.is_set),
            )
        )
        waiter.start()
        stop.set()
        waiter.join(timeout=5)
    assert not waiter.is_alive()
    assert got[0].reason == STOP_CANCELLED and calls == []


@needs_libx264
@pytest.mark.usefixtures("fresh_encoders")
def test_a_real_libx264_test_encode_passes_its_checks():
    result = video_probe.run_probe(VIDEO_CPU_ENCODER, TINY_W, TINY_H, TINY_FPS)
    assert result.ok, result.detail
    assert result.speed is not None and result.speed > 0
