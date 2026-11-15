"""Edits to a finished filmed take (#102): the export trim and the camera
offset. Neither re-renders audio.wav: the trim changes only what an export
covers, and the offset moves only the picture."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.api.takes_models import PatchTakeBody
from app.core.take_video import has_camera, take_span
from app.core.take_video_config import SPAN_EPSILON_SEC, TRIM_MIN_SEC
from app.core.takes_config import STEMS_DIRNAME, TAKE_RATE
from app.pipeline.take_render import song_frames

VIDEO_PATCH_FIELDS = ("trim", "camera_offset_ms")


def song_seconds(job_dir: Path) -> float | None:
    """The song's length from its stems, or None without one. Blocking."""
    frames = song_frames(job_dir / STEMS_DIRNAME)
    return None if frames is None else frames / TAKE_RATE


def asks_change(body: PatchTakeBody) -> bool:
    """A null trim clears it, so a sent trim is a change even when null."""
    sent = body.model_fields_set
    return "trim" in sent or any(getattr(body, n) is not None for n in sent)


def _checked_trim(trim: dict[str, float], span: tuple[float, float]) -> dict[str, float]:
    start, end = span
    lo, hi = trim["in_sec"], trim["out_sec"]
    if lo < start - SPAN_EPSILON_SEC or hi > end + SPAN_EPSILON_SEC:
        raise HTTPException(status_code=422, detail="trim outside the take")
    if hi - lo < TRIM_MIN_SEC - SPAN_EPSILON_SEC:
        raise HTTPException(status_code=422, detail="trim shorter than the minimum")
    return {"in_sec": max(lo, start), "out_sec": min(hi, end)}


def apply_video_patch(job_dir: Path, sidecar: dict[str, Any], body: PatchTakeBody) -> None:
    """Set or clear the trim and set the camera offset on `sidecar`, after
    any re-placement, so the trim is checked against the take's new span."""
    sent = body.model_fields_set
    if body.camera_offset_ms is not None:
        if not has_camera(sidecar):
            raise HTTPException(status_code=422, detail="take has no camera")
        sidecar["camera"]["offset_ms"] = body.camera_offset_ms
    if "trim" not in sent:
        return
    if body.trim is None:
        sidecar.pop("trim", None)
        return
    span = take_span(sidecar, song_seconds(job_dir))
    sidecar["trim"] = _checked_trim(body.trim.model_dump(), span)
