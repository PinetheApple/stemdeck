"""A filmed take's camera at open and finish time. Blocking: run in a thread
under the song's lock.

The picture is kept only when every chunk arrived, the bytes are a webm or
an mp4, and ffprobe finds a video stream in them. Otherwise it is dropped
and the take keeps its sound: the camera never costs the user the audio.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from app.api.takes_models import CreateTakeBody
from app.api.takes_video_models import CameraFinishModel
from app.core.take_video import camera_file
from app.core.take_video_config import (
    CAMERA_FILES,
    CAMERA_PART_FILE,
    DROP_NO_TIMING,
    DROP_NOT_VIDEO,
    DROP_PARTS_MISSING,
    TRACK_KIND_VIDEO,
)
from app.core.takes_config import EMPTY_PART_STATE, LOGGER_NAME
from app.pipeline.take_camera import CameraInfo, probe_camera, sniff_camera

logger = logging.getLogger(LOGGER_NAME)

CAMERA_STREAM = "camera"
_START_FIELDS = frozenset({"timeline", "latency", "capture"})


def start_fields(body: CreateTakeBody) -> set[str]:
    """The fields of the create body kept as the take's start sidecar."""
    return set(_START_FIELDS | ({CAMERA_STREAM} if body.camera else set()))


def filmed_state(body: CreateTakeBody, track: dict[str, Any]) -> dict[str, Any]:
    """parts.json additions: the video track's "I play" stems, copied so the
    take keeps what its monitor left out, and the camera's upload counters."""
    out: dict[str, Any] = {}
    if track.get("kind") == TRACK_KIND_VIDEO:
        out["i_play"] = list(track.get("i_play") or [])
    if body.camera is not None:
        out[CAMERA_STREAM] = dict(EMPTY_PART_STATE)
    return out


def _settle_file(folder: Path) -> tuple[Path | None, CameraInfo | None]:
    """The camera file and what is in it: one renamed at an earlier finish
    that did not complete, else camera.part renamed after sniffing."""
    path = camera_file(folder)
    if path is None:
        part = folder / CAMERA_PART_FILE
        name = sniff_camera(part)
        if name is None:
            return None, None
        path = folder / name
        os.replace(part, path)
    return path, probe_camera(path)


def _drop(folder: Path, reason: str) -> dict[str, Any]:
    for name in (CAMERA_PART_FILE, *CAMERA_FILES):
        (folder / name).unlink(missing_ok=True)
    logger.warning("take %s keeps its sound without the picture: %s", folder.name, reason)
    return {"camera_dropped": reason}


def finish_camera(
    folder: Path,
    state: dict[str, Any],
    body: CameraFinishModel | None,
) -> dict[str, Any]:
    """The sidecar's camera block, or {"camera_dropped": reason}; {} for a
    take opened without a camera."""
    start = state["start"].get(CAMERA_STREAM)
    if start is None:
        return {}
    if body is None:
        return _drop(folder, DROP_NO_TIMING)
    if body.parts != int(state[CAMERA_STREAM]["next_seq"]):
        return _drop(folder, DROP_PARTS_MISSING)
    path, info = _settle_file(folder)
    if path is None or info is None:
        return _drop(folder, DROP_NOT_VIDEO)
    return {
        "camera": {
            **start,
            "file": path.name,
            "width": info.width,
            "height": info.height,
            "duration_sec": info.duration_sec,
            "first_frame_offset_ms": body.first_frame_offset_ms,
            "first_frame_clock": body.first_frame_clock,
        }
    }
