"""A filmed take's camera file: what container the recorder's chunks make,
and what ffprobe finds in it. Blocking: run in a thread.

The file is kept as the browser wrote it, never re-encoded. Chrome's webm
carries no duration, so the length is read from the last video packet's end.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import NamedTuple

from app.core.config import TIMEOUT_FFMPEG, ffprobe_executable
from app.core.take_video_config import (
    CAMERA_MP4,
    CAMERA_WEBM,
    EBML_MAGIC,
    MP4_FTYP,
    MP4_FTYP_AT,
    SNIFF_BYTES,
)
from app.core.takes_config import LOGGER_NAME
from app.pipeline.video_process import ProcessStopped, run_watched

logger = logging.getLogger(LOGGER_NAME)

_PACKET_FIELDS = "stream=width,height:packet=pts_time,duration_time"


class CameraUnreadable(Exception):
    """ffprobe could not read the file."""


class CameraInfo(NamedTuple):
    width: int
    height: int
    duration_sec: float


def sniff_camera(path: Path) -> str | None:
    """The camera file name the bytes call for (camera.webm for EBML,
    camera.mp4 for an ftyp box), or None for anything else."""
    try:
        with path.open("rb") as fh:
            head = fh.read(SNIFF_BYTES)
    except OSError:
        return None
    if head.startswith(EBML_MAGIC):
        return CAMERA_WEBM
    if head[MP4_FTYP_AT : MP4_FTYP_AT + len(MP4_FTYP)] == MP4_FTYP:
        return CAMERA_MP4
    return None


def _ffprobe_json(path: Path) -> dict:
    cmd = [ffprobe_executable(), "-v", "error", "-select_streams", "v:0"]
    cmd += ["-show_entries", _PACKET_FIELDS, "-of", "json", str(path)]
    returncode, out, err = run_watched(cmd, TIMEOUT_FFMPEG)
    if returncode != 0:
        raise CameraUnreadable(err.strip())
    return json.loads(out or "{}")


def _packet_span(packets: list[dict]) -> float:
    """From the first packet's start to the last one's end, in seconds."""
    starts = [float(p["pts_time"]) for p in packets if "pts_time" in p]
    ends = [
        float(p["pts_time"]) + float(p.get("duration_time") or 0)
        for p in packets
        if "pts_time" in p
    ]
    return max(ends) - min(starts) if starts else 0.0


def probe_camera(path: Path) -> CameraInfo | None:
    """The video stream's size and length, or None when ffprobe finds no
    video stream with a frame in it."""
    try:
        info = _ffprobe_json(path)
    except (OSError, ProcessStopped, CameraUnreadable, ValueError):
        logger.warning("could not read the camera file %s", path, exc_info=True)
        return None
    streams = info.get("streams") or []
    duration = _packet_span(info.get("packets") or [])
    if not streams or duration <= 0:
        return None
    return CameraInfo(int(streams[0]["width"]), int(streams[0]["height"]), duration)
