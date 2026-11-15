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
    CLIENT_GONE_DETAIL,
    HTTP_CLIENT_GONE,
    fx_query,
    master_query,
    prepare_export,
)
from app.api.stems import (
    NO_TRANSPOSE_DETAIL,
    PITCHES_MAX_CHARS,
    _expand_render_lanes,
    _parse_lane_gains,
    _parse_pitches,
    _pitch_filter,
    _rubberband_available,
)
from app.core.config import JOB_ID_RE, MASTER_LOUDNESS_POLL_SEC, STEM_FORMAT_MP3, STEM_FORMAT_WAV

router = APIRouter(tags=["stems"])

# Any lossy format plans for the same capped ceiling.
_LOSSY_PLAN_FORMAT = STEM_FORMAT_MP3
_LOSSLESS_PLAN_FORMAT = STEM_FORMAT_WAV

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
    pitches: str = Query(default="", max_length=PITCHES_MAX_CHARS, description="As for mixdown"),
    fx: Annotated[str, fx_query()] = "",
    master: Annotated[str, master_query()] = "",
    lossy: bool = Query(default=False, description="Plan for a lossy export's capped ceiling"),
) -> dict:
    """The plan as JSON (docs/api.md); ``master`` is required here."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    names, parsed_gains = _parse_lane_gains(stems, gains)
    parsed_pitches = _parse_pitches(pitches, names)
    if any(parsed_pitches) and not await asyncio.to_thread(_rubberband_available):
        raise HTTPException(status_code=422, detail=NO_TRANSPOSE_DETAIL)
    lanes, _unpitched = _expand_render_lanes(job_id, names, parsed_gains, parsed_pitches)
    output_format = _LOSSY_PLAN_FORMAT if lossy else _LOSSLESS_PLAN_FORMAT
    export = await _unless_disconnected(
        request,
        prepare_export(lanes, fx, master, output_format, _pitch_filter, master_required=True),
    )
    return export.plan.to_json()
