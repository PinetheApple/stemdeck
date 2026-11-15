"""GET /jobs/{id}/mixdown/loudness: the measured master of a mix, the plan
the mastered export renders (app/api/export_fx.py), for the studio's Master
readout and its live preview.

The whole song is always measured, so there is no start/end, and a mix
measured once is answered from the plan cache. The studio asks again each
time the mix settles and drops the older request, so a measurement whose
client went away is cancelled (its ffmpeg killed) and answered with 499
rather than left to delay the one that is wanted.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable
from typing import Annotated, TypeVar

from fastapi import APIRouter, HTTPException, Query, Request

from app.api.export_fx import (
    build_render_fx,
    fx_query,
    master_query,
    parse_fx_query,
    plan_master,
    require_master_query,
)
from app.api.stems import (
    _expand_render_lanes,
    _parse_lane_gains,
    _parse_pitches,
    _pitch_filter,
    _rubberband_available,
)
from app.core.config import JOB_ID_RE, MASTER_LOUDNESS_POLL_SEC, STEM_FORMAT_MP3, STEM_FORMAT_WAV

router = APIRouter(tags=["stems"])

HTTP_CLIENT_GONE = 499
CLIENT_GONE_DETAIL = "client went away"
NO_TRANSPOSE_DETAIL = "this ffmpeg build cannot transpose (no rubberband filter)"
# Any lossy format plans for the same capped ceiling.
_LOSSY_PLAN_FORMAT = STEM_FORMAT_MP3
_LOSSLESS_PLAN_FORMAT = STEM_FORMAT_WAV
_PITCHES_MAX_CHARS = 128

T = TypeVar("T")


async def _unless_disconnected(request: Request, work: Awaitable[T]) -> T:
    """``work``'s result, or 499 once the client has gone (``work`` cancelled)."""
    task = asyncio.ensure_future(work)
    while not task.done():
        await asyncio.wait({task}, timeout=MASTER_LOUDNESS_POLL_SEC)
        if not task.done() and await request.is_disconnected():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            raise HTTPException(status_code=HTTP_CLIENT_GONE, detail=CLIENT_GONE_DETAIL)
    return task.result()


@router.get("/jobs/{job_id}/mixdown/loudness")
async def get_mixdown_loudness(
    request: Request,
    job_id: str,
    stems: str = Query(..., description="Comma-separated lane names to sum"),
    gains: str = Query(..., description="Comma-separated linear gains, parallel to stems"),
    pitches: str = Query(
        default="",
        max_length=_PITCHES_MAX_CHARS,
        description="As for mixdown",
    ),
    fx: Annotated[str, fx_query()] = "",
    master: Annotated[str, master_query()] = "",
    lossy: bool = Query(default=False, description="Plan for a lossy export's capped ceiling"),
) -> dict:
    """The plan as JSON: target, ceiling, comp, comp_ratio, pre {i, tp, lra},
    comp_threshold_db, comp_i, gain_db, post {i, tp, lra}, reached."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    names, parsed_gains = _parse_lane_gains(stems, gains)
    parsed_pitches = _parse_pitches(pitches, names)
    fx_req = parse_fx_query(fx)
    settings = require_master_query(master)
    if any(parsed_pitches) and not await asyncio.to_thread(_rubberband_available):
        raise HTTPException(status_code=422, detail=NO_TRANSPOSE_DETAIL)
    lanes, _unpitched = _expand_render_lanes(job_id, names, parsed_gains, parsed_pitches)
    render_fx = await asyncio.to_thread(build_render_fx, lanes, fx_req)
    output_format = _LOSSY_PLAN_FORMAT if lossy else _LOSSLESS_PLAN_FORMAT
    mastered = await _unless_disconnected(
        request,
        plan_master(lanes, render_fx, settings, output_format, _pitch_filter),
    )
    return mastered.plan.to_json()
