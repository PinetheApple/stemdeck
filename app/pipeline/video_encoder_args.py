"""ffmpeg arguments for each H.264 encoder, and where VAAPI can run.

Pure functions apart from the sysfs and /dev/dri reads, which go through the
DRI_DIR and SYS_DRM_DIR module attributes so a test can point them at a fake
tree. Nothing here takes a string from a request: encoder names come from the
whitelist in app/core/video_config.py.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

from app.core.video_config import (
    AMF,
    NVENC,
    QSV,
    VAAPI,
    VIDEO_AUDIO_ROOM_KBPS,
    VIDEO_CPU_ENCODER,
    VIDEO_GPU_MAX_BITS_PER_PIXEL,
    VIDEO_PIX_FMT,
    VIDEO_SIZE_CAP_FACTOR,
    VIDEO_SIZE_CAP_SLACK_BYTES,
    VIDEO_X264_CRF,
    VIDEOTOOLBOX,
    vaapi_device_override,
)

OS_WINDOWS = "windows"
OS_LINUX = "linux"
OS_MACOS = "macos"

# The GPU encoders worth a probe on each OS, in the order they are tried.
CANDIDATES: dict[str, tuple[str, ...]] = {
    OS_WINDOWS: (NVENC, QSV, AMF),
    OS_LINUX: (NVENC, VAAPI, QSV),
    OS_MACOS: (VIDEOTOOLBOX,),
}

# Auto tries only these; the others run only when picked. Upstream measured
# NVENC in real Windows exports; nothing else has run on real hardware yet.
AUTO: dict[str, tuple[str, ...]] = {
    OS_WINDOWS: (NVENC,),
    OS_LINUX: (),
    OS_MACOS: (),
}

FAMILY = {
    NVENC: "nvidia",
    QSV: "intel",
    AMF: "amd",
    VAAPI: "vaapi",
    VIDEOTOOLBOX: "apple",
    VIDEO_CPU_ENCODER: "cpu",
}

# H.264 levels: (name, max macroblocks per frame, per second, max High-profile
# kbit/s), from the spec's Table A-1.
_LEVELS = (
    ("3.1", 3600, 108000, 17500),
    ("3.2", 5120, 216000, 25000),
    ("4.0", 8192, 245760, 25000),
    ("4.1", 8192, 245760, 62500),
    ("4.2", 8704, 522240, 62500),
    ("5.0", 22080, 589824, 168750),
    ("5.1", 36864, 983040, 300000),
    ("5.2", 36864, 2073600, 300000),
)
_MACROBLOCK = 16
_BITS_PER_KBIT = 1000
_BITS_PER_BYTE = 8
_BUFSIZE_FACTOR = 2
_VIDEOTOOLBOX_BITRATE_DIVISOR = 3
_ENCODERS_WITH_FALLBACK_ARGS = (VIDEOTOOLBOX, NVENC)

DRI_DIR = Path("/dev/dri")
SYS_DRM_DIR = Path("/sys/class/drm")
_RENDER_NODE_RE = re.compile(r"renderD([0-9]+)")
_PCI_ID_RE = re.compile(r"0x([0-9a-fA-F]{4})")
_PCI_ID_READ_MAX = 32


def os_key(platform: str | None = None) -> str:
    plat = platform if platform is not None else sys.platform
    if plat.startswith("win"):
        return OS_WINDOWS
    if plat == "darwin":
        return OS_MACOS
    return OS_LINUX


def max_bitrate_kbps(width: int, height: int, fps: int) -> int:
    return int(width * height * fps * VIDEO_GPU_MAX_BITS_PER_PIXEL / _BITS_PER_KBIT)


def h264_level(width: int, height: int, fps: int) -> str:
    """The lowest level that holds this frame size, rate and bitrate ceiling."""
    mbs = -(-width // _MACROBLOCK) * -(-height // _MACROBLOCK)
    kbps = max_bitrate_kbps(width, height, fps)
    for name, frame_mbs, mbs_per_sec, level_kbps in _LEVELS:
        if mbs <= frame_mbs and mbs * fps <= mbs_per_sec and kbps <= level_kbps:
            return name
    return _LEVELS[-1][0]


def _level_kbps(level: str) -> int:
    return next(kbps for name, _f, _m, kbps in _LEVELS if name == level)


def variant_count(encoder: str) -> int:
    """Argument sets an encoder has, tried in order by the probe: NVENC's
    p1-p7 presets need ffmpeg 4.3, VideoToolbox's -q:v needs Apple Silicon."""
    return 2 if encoder in _ENCODERS_WITH_FALLBACK_ARGS else 1


def _ceiling(kbps: int) -> list[str]:
    return ["-maxrate", f"{kbps}k", "-bufsize", f"{_BUFSIZE_FACTOR * kbps}k"]


def _nvenc(width: int, height: int, fps: int, variant: int) -> list[str]:
    kbps = max_bitrate_kbps(width, height, fps)
    preset = ["-preset", "p4", "-tune", "hq"] if variant == 0 else ["-preset", "slow"]
    return [
        *preset,
        *["-rc", "vbr", "-cq", "19", "-b:v", "0"],
        *_ceiling(kbps),
        *["-profile:v", "high", "-level", h264_level(width, height, fps)],
        *["-pix_fmt", VIDEO_PIX_FMT],
    ]


def _qsv(width: int, height: int, fps: int, variant: int) -> list[str]:
    return [
        *["-preset", "medium", "-global_quality", "21", "-look_ahead", "0"],
        *["-profile:v", "high", "-pix_fmt", "nv12"],
    ]


def _amf(width: int, height: int, fps: int, variant: int) -> list[str]:
    return [
        *["-quality", "quality", "-rc", "cqp"],
        *["-qp_i", "20", "-qp_p", "22", "-qp_b", "24"],
        *["-profile:v", "high", "-pix_fmt", "nv12"],
    ]


def _vaapi(width: int, height: int, fps: int, variant: int) -> list[str]:
    # The frames are already on the device (output_filter's hwupload).
    return ["-rc_mode", "CQP", "-global_quality", "21", "-profile:v", "high"]


def _videotoolbox(width: int, height: int, fps: int, variant: int) -> list[str]:
    kbps = max_bitrate_kbps(width, height, fps)
    bitrate = ["-b:v", f"{kbps // _VIDEOTOOLBOX_BITRATE_DIVISOR}k", *_ceiling(kbps)]
    quality = ["-q:v", "65"] if variant == 0 else bitrate
    return [*quality, "-profile:v", "high", "-pix_fmt", VIDEO_PIX_FMT]


_GPU_ARGS = {NVENC: _nvenc, QSV: _qsv, AMF: _amf, VAAPI: _vaapi, VIDEOTOOLBOX: _videotoolbox}


def encoder_args(encoder: str, width: int, height: int, fps: int, variant: int = 0) -> list[str]:
    """The output's video codec arguments: libx264's fixed ones, or a GPU
    encoder's constant-quality style rate control, High profile, 8-bit 4:2:0."""
    if encoder == VIDEO_CPU_ENCODER:
        return libx264_args()
    build = _GPU_ARGS.get(encoder)
    if build is None:
        raise ValueError(f"not an H.264 encoder: {encoder}")
    return ["-c:v", encoder, *build(width, height, fps, variant)]


def libx264_args() -> list[str]:
    return ["-c:v", VIDEO_CPU_ENCODER, "-crf", str(VIDEO_X264_CRF), "-pix_fmt", VIDEO_PIX_FMT]


def global_args(encoder: str, device: str = "") -> list[str]:
    """Options before the inputs: VAAPI's render node, which also becomes the
    filter graph's device, so hwupload lands on the node that encodes."""
    if encoder != VAAPI:
        return []
    if not device:
        raise ValueError("h264_vaapi needs the render node its probe passed on")
    return ["-vaapi_device", device]


def output_filter(encoder: str) -> str:
    """The last filter of the video chain: the picture as the encoder takes it."""
    return "format=nv12,hwupload" if encoder == VAAPI else f"format={VIDEO_PIX_FMT}"


def size_cap_bytes(width: int, height: int, fps: int, duration_sec: float) -> int:
    """The largest file an honest render of this length can be: its level's
    bitrate plus the audio, with room for the container. Bigger is a runaway."""
    kbps = _level_kbps(h264_level(width, height, fps)) + VIDEO_AUDIO_ROOM_KBPS
    seconds = max(duration_sec, 1.0)
    payload = seconds * kbps * _BITS_PER_KBIT / _BITS_PER_BYTE
    return int(payload * VIDEO_SIZE_CAP_FACTOR) + VIDEO_SIZE_CAP_SLACK_BYTES


def render_nodes(platform: str | None = None) -> list[str]:
    """The DRM render nodes h264_vaapi may run on, in the order tried: the one
    STEMDECK_VAAPI_DEVICE pins (when it exists), else every renderD* by
    number. Empty off Linux and wherever there is no node."""
    if os_key(platform) != OS_LINUX:
        return []
    pinned = vaapi_device_override()
    if pinned is not None:
        node = DRI_DIR / pinned
        return [str(node)] if node.exists() else []
    try:
        found = [
            (int(m.group(1)), path)
            for path in DRI_DIR.iterdir()
            if (m := _RENDER_NODE_RE.fullmatch(path.name))
        ]
    except OSError:
        return []
    return [str(path) for _number, path in sorted(found)]


def _read_pci_id(path: Path) -> str:
    try:
        raw = path.read_text(encoding="ascii", errors="replace")[:_PCI_ID_READ_MAX].strip()
    except OSError:
        return ""
    match = _PCI_ID_RE.fullmatch(raw)
    return match.group(1).lower() if match else ""


def gpu_id(device: str) -> str:
    """The GPU behind a render node as "vendor:device" PCI ids, so a node
    number that now points at another GPU never reuses the old one's pass.
    "" when unknown: the cache is then keyed on the node alone."""
    if not device:
        return ""
    base = SYS_DRM_DIR / Path(device).name / "device"
    ids = [_read_pci_id(base / "vendor"), _read_pci_id(base / "device")]
    return ":".join(ids) if any(ids) else ""
