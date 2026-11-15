"""Names and tunable numbers of the filmed-take export's H.264 encoders
(app/pipeline/video_encoder.py). libx264 on the CPU is the default; a GPU
encoder is used only after it passes a real test encode."""

from __future__ import annotations

import sys
from pathlib import Path

from app.core.config import _env_int

LOGGER_NAME = "stemdeck.video_encoder"

VIDEO_CPU_ENCODER = "libx264"
NVENC = "h264_nvenc"
QSV = "h264_qsv"
AMF = "h264_amf"
VAAPI = "h264_vaapi"
VIDEOTOOLBOX = "h264_videotoolbox"
VIDEO_GPU_ENCODERS = (NVENC, QSV, AMF, VAAPI, VIDEOTOOLBOX)

POLICY_AUTO = "auto"
POLICY_CPU = "cpu"
VIDEO_ENCODER_CHOICES = (POLICY_AUTO, POLICY_CPU, *VIDEO_GPU_ENCODERS)

OS_WINDOWS = "windows"
OS_LINUX = "linux"
OS_MACOS = "macos"

# The GPU encoders worth a probe on each OS, in the order they are tried.
CANDIDATES: dict[str, tuple[str, ...]] = {
    OS_WINDOWS: (NVENC, QSV, AMF),
    OS_LINUX: (NVENC, VAAPI, QSV),
    OS_MACOS: (VIDEOTOOLBOX,),
}
# Unverified on real hardware: QSV, AMF, VideoToolbox and every Windows path.

OS_RELEASE_PATH = Path("/etc/os-release")
OS_RELEASE_ID = "ID"
OS_RELEASE_ID_LIKE = "ID_LIKE"

ENCODER_ENV = "STEMDECK_VIDEO_ENCODER"
VAAPI_DEVICE_ENV = "STEMDECK_VAAPI_DEVICE"

TIMEOUT_VIDEO_ENCODER_PROBE = _env_int("STEMDECK_TIMEOUT_VIDEO_ENCODER_PROBE", 20)
# A GPU render whose progress stops this long is redone on the CPU.
TIMEOUT_VIDEO_GPU_STALL = _env_int("STEMDECK_TIMEOUT_VIDEO_GPU_STALL", 60)
# A render's limit grows with its length, within these bounds: a slow CPU
# encodes 1080p60 well below realtime.
TIMEOUT_VIDEO_RENDER_MIN = _env_int("STEMDECK_TIMEOUT_VIDEO_RENDER", 300)
TIMEOUT_VIDEO_RENDER_MAX = _env_int("STEMDECK_TIMEOUT_VIDEO_RENDER_MAX", 6 * 3600)
VIDEO_RENDER_SEC_PER_SEC = 6.0
# The output check decodes the whole file, about realtime at worst.
TIMEOUT_VIDEO_VALIDATE_MIN = _env_int("STEMDECK_TIMEOUT_VIDEO_VALIDATE", 120)
VIDEO_VALIDATE_SEC_PER_SEC = 1.0

VIDEO_ENCODER_PROBE_SEC = 2
VIDEO_ENCODER_PASS_TTL_SEC = 7 * 24 * 3600
VIDEO_ENCODER_FAIL_TTL_SEC = 24 * 3600
# A busy device or a timeout says little about tomorrow: asked again soon.
VIDEO_ENCODER_RETRY_SEC = 600
VIDEO_ENCODER_MAX_FAILURES = 2
VIDEO_ENCODER_TEST_BUDGET_SEC = 150.0
VIDEO_ENCODER_CACHE_FILE = "video_encoders.json"
VIDEO_ENCODER_CACHE_VERSION = 1
PROBE_LOCK_POLL_SEC = 0.25

VIDEO_VALIDATE_DURATION_TOL_SEC = 0.5
VIDEO_VALIDATE_DURATION_TOL_FRAMES = 2
VIDEO_VALIDATE_FPS_TOL = 0.01
VIDEO_VALIDATE_MIN_BYTES = 4096
VIDEO_VALIDATE_MIN_BYTES_PER_SEC = 1000
# Under this much free space a short file is the disk's fault, not the encoder's.
VIDEO_LOW_DISK_BYTES = 64 * 1024 * 1024
# A moving test picture decodes to frames that differ; a broken encoder's
# solid green or black output does not.
VIDEO_PROBE_MIN_DISTINCT_FRAMES = 2

# GPU rate control: a bitrate ceiling per pixel per frame, and the audio and
# container room the file-size cap allows on top of the H.264 level's rate.
VIDEO_GPU_MAX_BITS_PER_PIXEL = 0.5
VIDEO_AUDIO_ROOM_KBPS = 256
VIDEO_SIZE_CAP_FACTOR = 1.5
VIDEO_SIZE_CAP_SLACK_BYTES = 1_000_000

VIDEO_X264_CRF = 20
VIDEO_PIX_FMT = "yuv420p"
GPU_UPLOAD_PIX_FMT = "nv12"
H264_PROFILE = "high"
NVENC_PRESET = "p4"
NVENC_TUNE = "hq"
NVENC_PRESET_OLD_FFMPEG = "slow"
NVENC_RATE_CONTROL = "vbr"
NVENC_CQ = 19
QSV_PRESET = "medium"
QSV_GLOBAL_QUALITY = 21
AMF_QUALITY = "quality"
AMF_RATE_CONTROL = "cqp"
AMF_QP_I = 20
AMF_QP_P = 22
AMF_QP_B = 24
VAAPI_RATE_CONTROL = "CQP"
VAAPI_GLOBAL_QUALITY = 21
VIDEOTOOLBOX_QUALITY = 65

AUDIO_CODEC = "aac"
TEST_AUDIO_RATE = 48000
TEST_AUDIO_LAYOUT = "stereo"

# The Settings test runs the lightest and the heaviest geometry on offer.
TEST_GEOMETRIES: dict[str, tuple[int, int, int]] = {
    "720p30": (1280, 720, 30),
    "1080p60": (1920, 1080, 60),
}

ERROR_LINE_MAX_CHARS = 160
VERSION_LINE_MAX_CHARS = 200
IDENTITY_HEX_CHARS = 16


def render_timeout_sec(duration_sec: float) -> float:
    """The time limit of a render of this many seconds of video."""
    scaled = duration_sec * VIDEO_RENDER_SEC_PER_SEC
    return float(max(TIMEOUT_VIDEO_RENDER_MIN, min(TIMEOUT_VIDEO_RENDER_MAX, scaled)))


def validate_timeout_sec(duration_sec: float) -> float:
    """The time limit of the full decode that checks a rendered file."""
    return max(TIMEOUT_VIDEO_VALIDATE_MIN, duration_sec * VIDEO_VALIDATE_SEC_PER_SEC)


def os_key(platform: str | None = None) -> str:
    plat = platform if platform is not None else sys.platform
    if plat.startswith("win"):
        return OS_WINDOWS
    if plat == "darwin":
        return OS_MACOS
    return OS_LINUX


def os_release_ids(platform: str | None = None) -> tuple[str | None, str | None]:
    """(ID, ID_LIKE) from /etc/os-release on Linux; None for each one missing,
    off Linux, or when the file cannot be read."""
    if os_key(platform) != OS_LINUX:
        return None, None
    try:
        text = OS_RELEASE_PATH.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None, None
    values: dict[str, str] = {}
    for line in text.splitlines():
        key, sep, value = line.partition("=")
        if sep:
            values[key.strip()] = value.strip().strip("\"'")
    return values.get(OS_RELEASE_ID) or None, values.get(OS_RELEASE_ID_LIKE) or None


def encoder_choices(platform: str | None = None) -> tuple[str, ...]:
    """What Settings offers on this OS: Auto, CPU only, then each candidate."""
    return (POLICY_AUTO, POLICY_CPU, *CANDIDATES[os_key(platform)])


def normalise_choice(value: object) -> str:
    """A choice as the setting and the env override compare it."""
    return str(value).strip().lower()
