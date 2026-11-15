"""Encoder arguments, the time limits and where VAAPI can run."""

from __future__ import annotations

import pytest

from app.core import video_config
from app.core.video_config import (
    NVENC,
    VAAPI,
    VIDEO_CPU_ENCODER,
    VIDEO_RENDER_TIMEOUT_MAX_SEC,
    VIDEO_RENDER_TIMEOUT_MIN_SEC,
    render_timeout_sec,
    validate_timeout_sec,
)
from app.pipeline import video_encoder_args as args


def test_libx264_args_are_the_fixed_cpu_encode():
    assert args.encoder_args(VIDEO_CPU_ENCODER, 1920, 1080, 30) == [
        "-c:v",
        "libx264",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
    ]


@pytest.mark.parametrize("encoder", video_config.VIDEO_GPU_ENCODERS)
def test_every_gpu_encoder_names_itself(encoder):
    out = args.encoder_args(encoder, 1920, 1080, 60)
    assert out[:2] == ["-c:v", encoder]


def test_unknown_encoder_is_refused():
    with pytest.raises(ValueError):
        args.encoder_args("h264_vulkan", 1280, 720, 30)


def test_nvenc_second_variant_drops_the_p_presets():
    assert "p4" in args.encoder_args(NVENC, 1280, 720, 30, 0)
    assert "slow" in args.encoder_args(NVENC, 1280, 720, 30, 1)
    assert args.variant_count(NVENC) == 2
    assert args.variant_count(VAAPI) == 1


def test_level_grows_with_the_frame_rate():
    assert args.h264_level(1280, 720, 30) == "3.1"
    assert args.h264_level(1920, 1080, 60) == "4.2"


def test_vaapi_runs_on_a_named_node_only():
    assert args.global_args(VAAPI, "/dev/dri/renderD129") == [
        "-vaapi_device",
        "/dev/dri/renderD129",
    ]
    assert args.global_args(NVENC) == []
    with pytest.raises(ValueError):
        args.global_args(VAAPI)
    assert args.output_filter(VAAPI) == "format=nv12,hwupload"


def test_auto_tries_no_gpu_on_linux_until_one_is_verified():
    assert args.AUTO[args.OS_LINUX] == ()
    assert args.AUTO[args.OS_WINDOWS] == (NVENC,)
    assert args.os_key("win32") == args.OS_WINDOWS
    assert args.os_key("darwin") == args.OS_MACOS


def test_render_timeout_scales_with_length_within_its_bounds(monkeypatch):
    monkeypatch.delenv("STEMDECK_TIMEOUT_VIDEO_RENDER", raising=False)
    monkeypatch.delenv("STEMDECK_TIMEOUT_VIDEO_RENDER_MAX", raising=False)
    assert render_timeout_sec(10) == VIDEO_RENDER_TIMEOUT_MIN_SEC
    assert render_timeout_sec(300) == 1800
    assert render_timeout_sec(3 * 3600) == VIDEO_RENDER_TIMEOUT_MAX_SEC
    assert validate_timeout_sec(10) == 120
    assert validate_timeout_sec(600) == 600


def test_render_timeout_bounds_follow_the_env(monkeypatch):
    monkeypatch.setenv("STEMDECK_TIMEOUT_VIDEO_RENDER", "60")
    monkeypatch.setenv("STEMDECK_TIMEOUT_VIDEO_RENDER_MAX", "100")
    assert render_timeout_sec(5) == 60
    assert render_timeout_sec(300) == 100


def _fake_drm(tmp_path, nodes):
    dri = tmp_path / "dri"
    dri.mkdir()
    sysfs = tmp_path / "drm"
    for name, vendor, device in nodes:
        (dri / name).touch()
        base = sysfs / name / "device"
        base.mkdir(parents=True)
        (base / "vendor").write_text(f"0x{vendor}\n")
        (base / "device").write_text(f"0x{device}\n")
    return dri, sysfs


def test_render_nodes_in_number_order_and_their_gpu(monkeypatch, tmp_path):
    monkeypatch.delenv("STEMDECK_VAAPI_DEVICE", raising=False)
    dri, sysfs = _fake_drm(
        tmp_path,
        [("renderD129", "1002", "1900"), ("renderD128", "10de", "2dd8"), ("card0", "0", "0")],
    )
    monkeypatch.setattr(args, "DRI_DIR", dri)
    monkeypatch.setattr(args, "SYS_DRM_DIR", sysfs)
    nodes = args.render_nodes("linux")
    assert [n.rsplit("/", 1)[1] for n in nodes] == ["renderD128", "renderD129"]
    assert args.gpu_id(nodes[1]) == "1002:1900"
    assert args.render_nodes("win32") == []


def test_vaapi_device_env_pins_one_node(monkeypatch, tmp_path):
    dri, _sysfs = _fake_drm(
        tmp_path,
        [("renderD128", "10de", "2dd8"), ("renderD129", "1002", "1900")],
    )
    monkeypatch.setattr(args, "DRI_DIR", dri)
    monkeypatch.setenv("STEMDECK_VAAPI_DEVICE", "/dev/dri/renderD129")
    assert args.render_nodes("linux") == [str(dri / "renderD129")]
    monkeypatch.setenv("STEMDECK_VAAPI_DEVICE", "renderD200")
    assert args.render_nodes("linux") == []
    monkeypatch.setenv("STEMDECK_VAAPI_DEVICE", "card0")
    assert len(args.render_nodes("linux")) == 2
