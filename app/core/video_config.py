"""Tunable numbers and names for the filmed-take export's H.264 encoders
(app/pipeline/video_encoder.py). libx264 on the CPU is the default and the
answer to every doubt; a GPU encoder is a speed-up that has to prove itself.

The two environment variables are read on every call, not at import, so a
test or a restarted unit sees the value it was given.
"""

from __future__ import annotations

import logging
import os
import re

LOGGER_NAME = "stemdeck.video_encoder"
logger = logging.getLogger(LOGGER_NAME)

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

ENCODER_ENV = "STEMDECK_VIDEO_ENCODER"
VAAPI_DEVICE_ENV = "STEMDECK_VAAPI_DEVICE"
RENDER_TIMEOUT_MIN_ENV = "STEMDECK_TIMEOUT_VIDEO_RENDER"
RENDER_TIMEOUT_MAX_ENV = "STEMDECK_TIMEOUT_VIDEO_RENDER_MAX"

# A probe is a real encode of a moving test picture at the render's own size
# and rate, written to an MP4 and put through the same check as a render.
VIDEO_ENCODER_PROBE_SEC = 2
TIMEOUT_VIDEO_ENCODER_PROBE = 20.0
VIDEO_ENCODER_PASS_TTL_SEC = 7 * 24 * 3600
VIDEO_ENCODER_FAIL_TTL_SEC = 24 * 3600
# A busy device or a timeout says little about tomorrow: asked again soon.
VIDEO_ENCODER_RETRY_SEC = 600
# Encoder-blamed render failures before the encoder is off until restart.
VIDEO_ENCODER_MAX_FAILURES = 2
VIDEO_ENCODER_TEST_BUDGET_SEC = 150.0
VIDEO_ENCODER_CACHE_FILE = "video_encoders.json"
VIDEO_ENCODER_CACHE_VERSION = 1

# A GPU render whose progress has not moved this long is stopped and redone
# on the CPU.
TIMEOUT_VIDEO_GPU_STALL = 60.0

# Render time limit: this many seconds per second of video, within the floor
# and ceiling. A slow laptop CPU runs a 1080p60 libx264 encode well below
# realtime, and a flat limit cut long takes short.
VIDEO_RENDER_SEC_PER_SEC = 6.0
VIDEO_RENDER_TIMEOUT_MIN_SEC = 300
VIDEO_RENDER_TIMEOUT_MAX_SEC = 6 * 3600

# The output check decodes the whole file: about realtime at worst.
TIMEOUT_VIDEO_VALIDATE_MIN = 120.0
VIDEO_VALIDATE_SEC_PER_SEC = 1.0
VIDEO_VALIDATE_DURATION_TOL_SEC = 0.5
VIDEO_VALIDATE_DURATION_TOL_FRAMES = 2
VIDEO_VALIDATE_FPS_TOL = 0.01
VIDEO_VALIDATE_MIN_BYTES = 4096
VIDEO_VALIDATE_MIN_BYTES_PER_SEC = 1000

# GPU rate control: a bitrate ceiling per pixel per frame, and the AAC and
# container room the file-size cap allows on top of the H.264 level's rate.
VIDEO_GPU_MAX_BITS_PER_PIXEL = 0.5
VIDEO_AUDIO_ROOM_KBPS = 256
VIDEO_SIZE_CAP_FACTOR = 1.5
VIDEO_SIZE_CAP_SLACK_BYTES = 1_000_000

VIDEO_X264_CRF = 20
VIDEO_PIX_FMT = "yuv420p"
VIDEO_TEST_AUDIO_RATE = 48000

# The Settings test runs the lightest and the heaviest geometry on offer.
TEST_GEOMETRIES: dict[str, tuple[int, int, int]] = {
    "720p30": (1280, 720, 30),
    "1080p60": (1920, 1080, 60),
}

ERROR_LINE_MAX_CHARS = 160
VERSION_LINE_MAX_CHARS = 200
IDENTITY_HEX_CHARS = 16

_RENDER_NODE_RE = re.compile(r"(?:/dev/dri/)?(renderD[0-9]+)")


def _env_seconds(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        return int(raw) if raw else default
    except ValueError:
        logger.warning("%s=%r is not a number of seconds; ignored", name, raw)
        return default


def encoder_override() -> str | None:
    """STEMDECK_VIDEO_ENCODER when it names a choice, else None. "cpu" is the
    kill switch: it wins over the setting."""
    raw = os.environ.get(ENCODER_ENV, "").strip().lower()
    if not raw:
        return None
    if raw not in VIDEO_ENCODER_CHOICES:
        logger.warning("%s=%r is not one of %s; ignored", ENCODER_ENV, raw, VIDEO_ENCODER_CHOICES)
        return None
    return raw


def vaapi_device_override() -> str | None:
    """The render node STEMDECK_VAAPI_DEVICE names ("renderD129" or its full
    path) as a bare node name, else None."""
    raw = os.environ.get(VAAPI_DEVICE_ENV, "").strip()
    if not raw:
        return None
    match = _RENDER_NODE_RE.fullmatch(raw)
    if match is None:
        logger.warning(
            "%s=%r is not a render node such as renderD128; ignored", VAAPI_DEVICE_ENV, raw
        )
        return None
    return match.group(1)


def render_timeout_sec(duration_sec: float) -> float:
    """The time limit of a render of this many seconds of video."""
    floor = _env_seconds(RENDER_TIMEOUT_MIN_ENV, VIDEO_RENDER_TIMEOUT_MIN_SEC)
    ceiling = _env_seconds(RENDER_TIMEOUT_MAX_ENV, VIDEO_RENDER_TIMEOUT_MAX_SEC)
    return float(max(floor, min(ceiling, duration_sec * VIDEO_RENDER_SEC_PER_SEC)))


def validate_timeout_sec(duration_sec: float) -> float:
    """The time limit of the full decode that checks a rendered file."""
    return max(TIMEOUT_VIDEO_VALIDATE_MIN, duration_sec * VIDEO_VALIDATE_SEC_PER_SEC)
