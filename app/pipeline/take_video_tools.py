"""Whether this ffmpeg can make a filmed take's MP4 at all: libx264 for the
CPU path every render can fall back to, and the AAC encoder for its sound.
Asked once per process; the binary does not change while it runs."""

from __future__ import annotations

import functools
import logging
import re
import subprocess

from app.core.config import ffmpeg_executable
from app.core.video_config import (
    AUDIO_CODEC,
    LOGGER_NAME,
    TIMEOUT_VIDEO_ENCODER_PROBE,
    VIDEO_CPU_ENCODER,
)

logger = logging.getLogger(LOGGER_NAME)

REQUIRED_ENCODERS = (VIDEO_CPU_ENCODER, AUDIO_CODEC)


@functools.cache
def render_tools_available() -> bool:
    try:
        listed = subprocess.run(  # noqa: S603 -- list args, trusted ffmpeg
            [ffmpeg_executable(), "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_VIDEO_ENCODER_PROBE,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        logger.warning("could not list this ffmpeg's encoders", exc_info=True)
        return False
    return all(re.search(rf"\s{re.escape(name)}\s", listed) for name in REQUIRED_ENCODERS)
