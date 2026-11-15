"""What a filmed take's export renders (#102, #99): the request checked and
turned into a RenderPlan, before the render queues, so a bad request is a
422 at once rather than a failed render later. Blocking: run in a thread.

The backing goes through the mixdown export's own helpers in
app/api/stems.py, so its lanes, gains, transposes and rebuilt original are
the ones the audio export makes.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.api.stems import (
    _expand_render_lanes,
    _parse_lane_gains,
    _parse_pitches,
    _pitch_filter,
    _rubberband_available,
)
from app.api.takes_lanes import EXPORT_LIMITER, is_take_lane
from app.api.takes_video_edit import song_seconds
from app.api.takes_video_iplay import Lane, without_played
from app.api.takes_video_models import RenderBody
from app.core.settings import get_export_sample_rate
from app.core.stem_files import stem_path
from app.core.take_video import camera_file, camera_start_sec, export_span, has_camera
from app.core.take_video_config import RENDER_SIZES, SPAN_EPSILON_SEC, TRIM_MIN_SEC
from app.core.takes import read_json, read_tracks
from app.core.takes_config import SIDECAR_FILE, STEMS_DIRNAME, TAKE_WAV_FILE, TRACK_ID_RE
from app.pipeline.take_video_render import AudioLane, RenderPlan


@dataclass(frozen=True)
class PlannedRender:
    plan: RenderPlan
    # The request with its defaults filled in, kept in render.json.
    request: dict[str, Any]
    inputs_sig: str


def inputs_sig(folder: Path, sidecar: dict[str, Any], request: dict[str, Any]) -> str:
    """What the render read: a change to any of it makes render.mp4 stale."""
    wav = folder / TAKE_WAV_FILE
    state = {
        "placement": sidecar.get("placement_sec"),
        "camera": sidecar.get("camera"),
        "trim": sidecar.get("trim"),
        "request": request,
        "wav": wav.stat().st_mtime_ns if wav.is_file() else None,
    }
    blob = json.dumps(state, sort_keys=True).encode()
    return hashlib.sha1(blob, usedforsecurity=False).hexdigest()


def _plays_this_take(job_dir: Path, take_id: str, name: str) -> bool:
    if name == take_id:
        return True
    if not TRACK_ID_RE.match(name):
        return False
    return any(t["id"] == name and t.get("active_take_id") == take_id for t in read_tracks(job_dir))


def _requested_lanes(job_dir: Path, take_id: str, body: RenderBody) -> list[Lane]:
    if not body.stems:
        return []
    names, gains = _parse_lane_gains(",".join(body.stems), ",".join(map(str, body.gains)))
    if any(_plays_this_take(job_dir, take_id, n) for n in names if is_take_lane(n)):
        raise HTTPException(status_code=422, detail="the take is already in the export")
    pitches = _parse_pitches(",".join(map(str, body.pitches or [])), names)
    pitches = [0 if is_take_lane(n) else p for n, p in zip(names, pitches, strict=True)]
    return [Lane(*lane) for lane in zip(names, gains, pitches, strict=True)]


def _backing(job_id: str, job_dir: Path, lanes: list[Lane], i_play: list[str]) -> list[AudioLane]:
    stems = job_dir / STEMS_DIRNAME
    kept = without_played(lanes, i_play, lambda name: stem_path(stems, name).is_file())
    if any(lane.pitch for lane in kept) and not _rubberband_available():
        raise HTTPException(
            status_code=422,
            detail="this ffmpeg build cannot transpose (no rubberband filter)",
        )
    rendered, _unpitched = _expand_render_lanes(
        job_id,
        [lane.name for lane in kept],
        [lane.gain for lane in kept],
        [lane.pitch for lane in kept],
    )
    return [AudioLane(r.path, r.gain, _pitch_filter(r.pitch)) for r in rendered]


def _span(job_dir: Path, sidecar: dict[str, Any]) -> tuple[float, float]:
    start, end = export_span(sidecar, song_seconds(job_dir))
    if end - start < TRIM_MIN_SEC - SPAN_EPSILON_SEC:
        raise HTTPException(status_code=422, detail="take too short to export")
    return start, end - start


def _filled_request(sidecar: dict[str, Any], body: RenderBody) -> dict[str, Any]:
    request = body.model_dump()
    if body.i_play is None:
        request["i_play"] = list(sidecar.get("i_play") or [])
    if body.mirror is None:
        request["mirror"] = bool(sidecar["camera"].get("mirror"))
    return request


def plan_render(job_id: str, job_dir: Path, folder: Path, body: RenderBody) -> PlannedRender:
    """The render of a finished take's camera over its export mix, or a 422."""
    sidecar = read_json(folder / SIDECAR_FILE)
    camera = camera_file(folder)
    if not has_camera(sidecar) or camera is None:
        raise HTTPException(status_code=422, detail="take has no camera")
    request = _filled_request(sidecar, body)
    lanes = _requested_lanes(job_dir, folder.name, body)
    backing = _backing(job_id, job_dir, lanes, request["i_play"])
    start, duration = _span(job_dir, sidecar)
    width, height = RENDER_SIZES[body.size]
    plan = RenderPlan(
        camera=camera,
        camera_start_sec=camera_start_sec(sidecar),
        mirror=request["mirror"],
        lanes=(*backing, AudioLane(folder / TAKE_WAV_FILE, body.take_gain)),
        start_sec=start,
        duration_sec=duration,
        width=width,
        height=height,
        fps=body.fps,
        sample_rate=get_export_sample_rate(),
        limiter=EXPORT_LIMITER,
    )
    return PlannedRender(plan, request, inputs_sig(folder, sidecar, request))
