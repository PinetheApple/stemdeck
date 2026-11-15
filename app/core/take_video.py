"""Filmed takes on disk: where a take's camera file is, when its picture
starts on the song clock, and the span an export covers. Free of FastAPI
and ffmpeg.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.take_video_config import CAMERA_FILES, CAMERA_PART_FILE
from app.core.takes_config import MS_PER_SEC


def camera_file(folder: Path) -> Path | None:
    """The take's finished camera file, or None."""
    return next((folder / n for n in CAMERA_FILES if (folder / n).is_file()), None)


def holds_camera(folder: Path) -> bool:
    """A camera file, or camera chunks that have started to arrive."""
    part = folder / CAMERA_PART_FILE
    return camera_file(folder) is not None or (part.is_file() and part.stat().st_size > 0)


def has_camera(sidecar: dict[str, Any]) -> bool:
    return isinstance(sidecar.get("camera"), dict)


def camera_offset_ms(sidecar: dict[str, Any]) -> float:
    camera = sidecar.get("camera") or {}
    return float(camera.get("offset_ms") or 0.0)


def camera_start_sec(sidecar: dict[str, Any]) -> float:
    """Song time of the camera's first frame. The picture shares the sound's
    placement; a positive camera offset means the picture ran late."""
    camera = sidecar.get("camera") or {}
    return (
        float(sidecar.get("placement_sec") or 0.0)
        + float(camera.get("first_frame_offset_ms") or 0.0) / MS_PER_SEC
        - camera_offset_ms(sidecar) / MS_PER_SEC
    )


def take_span(sidecar: dict[str, Any], song_sec: float | None) -> tuple[float, float]:
    """The part of the song the take covers: [max(0, placement),
    min(song length, placement + raw length)]."""
    placement = float(sidecar.get("placement_sec") or 0.0)
    end = placement + float(sidecar.get("duration_sec") or 0.0)
    if song_sec is not None:
        end = min(song_sec, end)
    return max(0.0, placement), end


def export_span(sidecar: dict[str, Any], song_sec: float | None) -> tuple[float, float]:
    """The range an export covers: the trim inside the take's span, else the span."""
    start, end = take_span(sidecar, song_sec)
    trim = sidecar.get("trim")
    if isinstance(trim, dict):
        start = max(start, float(trim["in_sec"]))
        end = min(end, float(trim["out_sec"]))
    return start, end


def video_entry_fields(
    job_id: str,
    sidecar: dict[str, Any],
    song_sec: float | None,
) -> dict[str, Any]:
    """The lane entry's filmed-take fields; an audio take reads has_camera false."""
    start, end = take_span(sidecar, song_sec)
    filmed = has_camera(sidecar)
    base = f"/api/jobs/{job_id}/takes/{sidecar['id']}"
    return {
        "has_camera": filmed,
        "camera_url": f"{base}/camera" if filmed else None,
        "camera_offset_ms": camera_offset_ms(sidecar),
        "camera_dropped": sidecar.get("camera_dropped"),
        "span": {"start_sec": start, "end_sec": end},
        "trim": sidecar.get("trim"),
        "i_play": list(sidecar.get("i_play") or []),
    }
