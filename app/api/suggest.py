"""Suggest EQ: a GET route that measures one lane and proposes ordinary EQ bands.

``GET /api/jobs/{id}/suggest/eq?lane=&layout=&target=&mode=&fx=`` measures
the lane's file raw (before any EQ, gain or pitch) and answers with bands, an
output gain, i18n reasons and the target choices (app/pipeline/eq_suggest.py).
The client turns that into an ordinary EQ descriptor; nothing is written.

The lane decides its EQ panel the way the client does (drums the drum graph,
bass, guitar and piano their pedals, every other lane the graph). ``layout``
may be left out; when sent it must name that panel.

The measurement (the gated spectrum, app/pipeline/eq_analysis.py) runs once
per lane file, in one ffmpeg decode streamed into the accumulator, and is
cached on disk under SUGGEST_CACHE_DIR keyed by the file's path, size and
mtime; asking for another target or mode reuses it. At most
SUGGEST_CONCURRENCY analyses run at once and one lane is never analysed twice
at the same time. A request whose client has gone away is stopped, ffmpeg
included.

Validation runs before any I/O: the job id, the lane from the mixdown
allow-list, the layout and mode against the lane's panel, the target from the
lane's own family, ``fx`` through the strict export parser, then the path
through the same guard as the exports. Error details are generic: 404 for a
job or lane that is not there, 422 for a bad parameter or ``not enough
signal``, 500 ``analysis failed`` (logged under stemdeck.suggest), 499 when
the client left.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
from collections import deque
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request

from app.api.stems import _MIXDOWN_NAMES, _drain_stderr, _validate_stem_path
from app.core.config import (
    FX_PARAM_MAX_CHARS,
    JOB_ID_RE,
    SUGGEST_CACHE_DIR,
    SUGGEST_CACHE_MAX_FILES,
    SUGGEST_CONCURRENCY,
    SUGGEST_DISCONNECT_POLL_SEC,
    SUGGEST_MAX_BANDS_LANE,
    TIMEOUT_FFMPEG,
    ffmpeg_executable,
)
from app.pipeline.eq_analysis import (
    ANALYSIS_RATE,
    CHANNELS,
    Spectrum,
    SpectrumAccumulator,
    spectrum_from_json,
    spectrum_to_json,
)
from app.pipeline.eq_fit import FIXED_LAYOUTS, FREE
from app.pipeline.eq_suggest import (
    MERGE,
    MODES,
    NOT_ENOUGH_SIGNAL,
    REPLACE,
    NotEnoughSignal,
    make_suggestion,
)
from app.pipeline.eq_targets import LANE_USE, Target, default_target, get_target, targets_for_use
from app.pipeline.fx_filters import Eq, FxError, parse_fx_param
from app.pipeline.master_plan_cache import keyed_lock, read_cache, write_cache
from app.pipeline.mastering import _STDERR_TAIL_LINES

logger = logging.getLogger("stemdeck.suggest")

router = APIRouter(tags=["suggest"])

CACHE_VERSION = "1"
GRAPH_PANEL = "graph"
DRUM_PANEL = "drum"
PANEL_OF_LANE = {"drums": DRUM_PANEL, "bass": "bass", "guitar": "guitar", "piano": "keys"}
PANEL_LAYOUTS = {GRAPH_PANEL: FREE, DRUM_PANEL: FREE, **{p: p for p in FIXED_LAYOUTS}}
_MERGE_PANELS = frozenset({GRAPH_PANEL, DRUM_PANEL})
_READ_BYTES = 1 << 20
_SAMPLE_BYTES = 4
_FRAME_BYTES = _SAMPLE_BYTES * CHANNELS
_EXIT_GRACE_SEC = 30
_CLIENT_GONE = 499
_LANE_MAX_CHARS = 32
_TARGET_MAX_CHARS = 40
_CHOICE_MAX_CHARS = 16

_analysis_slots = asyncio.Semaphore(SUGGEST_CONCURRENCY)
_analysis_locks: dict[str, asyncio.Lock] = {}


class AnalysisError(RuntimeError):
    """ffmpeg failed while analysing. The message is for the log only."""


def _decode_cmd(path: Path) -> list[str]:
    return [
        *(ffmpeg_executable(), "-nostdin", "-hide_banner", "-nostats", "-loglevel", "error"),
        *("-i", str(path), "-map", "0:a:0", "-ac", str(CHANNELS), "-ar", str(ANALYSIS_RATE)),
        *("-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"),
    ]


async def _feed(stream: asyncio.StreamReader, acc: SpectrumAccumulator) -> None:
    carry = b""
    while chunk := await stream.read(_READ_BYTES):
        data = carry + chunk
        usable = len(data) - len(data) % _FRAME_BYTES
        carry = data[usable:]
        if usable:
            await asyncio.to_thread(acc.feed, np.frombuffer(data[:usable], dtype="<f4"))
    await asyncio.to_thread(acc.finish)


async def _stop(proc: asyncio.subprocess.Process, drainer: asyncio.Task) -> None:
    if proc.returncode is None:
        proc.kill()
        await proc.wait()
    if not drainer.done():
        drainer.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await drainer


async def _run_analysis(path: Path) -> Spectrum:
    """Decode ``path`` to float stereo at the analysis rate, streamed into the
    gated spectrum. Raises AnalysisError."""
    proc = await asyncio.create_subprocess_exec(
        *_decode_cmd(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    tail: deque[str] = deque(maxlen=_STDERR_TAIL_LINES)
    drainer = asyncio.create_task(_drain_stderr(proc.stderr, tail))
    acc = SpectrumAccumulator()
    try:
        await asyncio.wait_for(_feed(proc.stdout, acc), timeout=TIMEOUT_FFMPEG)
        await asyncio.wait_for(proc.wait(), timeout=_EXIT_GRACE_SEC)
        await drainer
    except (TimeoutError, asyncio.TimeoutError):
        raise AnalysisError("analysis timed out") from None
    finally:
        await _stop(proc, drainer)
    if proc.returncode != 0:
        raise AnalysisError(f"ffmpeg exit {proc.returncode}: {' | '.join(tail)}")
    return await asyncio.to_thread(acc.result)


def _read_spectrum(path: Path) -> Spectrum | None:
    data = read_cache(path)
    try:
        return None if data is None else spectrum_from_json(data)
    except (KeyError, TypeError, ValueError):
        logger.debug("unreadable suggest cache %s", path, exc_info=True)
        return None


def _cache_path(job_id: str, lane: str, path: Path) -> Path:
    st = path.stat()
    raw = "|".join([CACHE_VERSION, job_id, lane, f"{path}@{st.st_size}:{st.st_mtime_ns}"])
    key = hashlib.sha1(raw.encode("utf-8"), usedforsecurity=False).hexdigest()
    return SUGGEST_CACHE_DIR / f"{key}.json"


async def _measure(cache: Path, job_id: str, path: Path) -> Spectrum:
    async with _analysis_slots:
        try:
            spec = await _run_analysis(path)
        except AnalysisError as exc:
            logger.warning("suggest analysis failed [job=%s]: %s", job_id, exc)
            raise HTTPException(status_code=500, detail="analysis failed") from None
    body = spectrum_to_json(spec)
    await asyncio.to_thread(write_cache, cache, body, SUGGEST_CACHE_MAX_FILES)
    return spec


async def analysis(job_id: str, lane: str, path: Path) -> Spectrum:
    """The cached spectrum of the lane's file, measured now when absent."""
    cache = await asyncio.to_thread(_cache_path, job_id, lane, path)
    async with keyed_lock(_analysis_locks, cache.stem):
        cached = await asyncio.to_thread(_read_spectrum, cache)
        return cached if cached is not None else await _measure(cache, job_id, path)


async def _until_done(request: Request, coro):
    """Run ``coro``, stopping it (and its ffmpeg) when the client goes away."""
    task = asyncio.create_task(coro)
    while not task.done():
        await asyncio.wait({task}, timeout=SUGGEST_DISCONNECT_POLL_SEC)
        if not task.done() and await request.is_disconnected():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
            raise HTTPException(status_code=_CLIENT_GONE, detail="client went away")
    return task.result()


def _lane_target(lane: str, target: str) -> Target:
    """The lane's own target family, and the asked-for target within it."""
    if lane not in _MIXDOWN_NAMES:
        raise HTTPException(status_code=422, detail="unknown lane")
    if lane not in LANE_USE:
        raise HTTPException(status_code=422, detail="no target for this lane")
    chosen = get_target(target) if target else default_target(lane)
    if chosen is None or chosen.use != LANE_USE[lane]:
        raise HTTPException(status_code=422, detail="unknown target")
    return chosen


def _lane_panel(lane: str, layout: str, mode: str) -> str:
    panel = PANEL_OF_LANE.get(lane, GRAPH_PANEL)
    if layout and layout != panel:
        raise HTTPException(status_code=422, detail="layout does not match the lane")
    if mode not in MODES or (mode == MERGE and panel not in _MERGE_PANELS):
        raise HTTPException(status_code=422, detail="unknown mode")
    return panel


def _current_eq(fx: str, lane: str) -> Eq | None:
    try:
        request = parse_fx_param(fx)
    except FxError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None
    return (request.lanes.get(lane) or [None])[0]


def _answer(spec: Spectrum, chosen: Target, layout: str, mode: str, current: Eq | None) -> dict:
    choices = [t.choice() for t in targets_for_use(chosen.use)]
    try:
        return make_suggestion(
            spec,
            chosen,
            layout,
            mode,
            current,
            SUGGEST_MAX_BANDS_LANE,
            choices,
        )
    except NotEnoughSignal:
        raise HTTPException(status_code=422, detail=NOT_ENOUGH_SIGNAL) from None


@router.get("/jobs/{job_id}/suggest/eq")
async def suggest_lane_eq(
    request: Request,
    job_id: str,
    lane: str = Query(..., max_length=_LANE_MAX_CHARS, description="Mixer lane"),
    layout: str = Query("", max_length=_CHOICE_MAX_CHARS, description="The lane's panel kind"),
    target: str = Query("", max_length=_TARGET_MAX_CHARS, description="Target id"),
    mode: str = Query(REPLACE, max_length=_CHOICE_MAX_CHARS, description="replace or merge"),
    fx: str = Query("", max_length=FX_PARAM_MAX_CHARS, description="The lane's EQ now"),
) -> dict:
    """Measure one lane (its file, before any EQ) and suggest EQ bands that
    move it towards a target curve, in the lane's panel's own terms."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    chosen = _lane_target(lane, target)
    panel = _lane_panel(lane, layout, mode)
    current = _current_eq(fx, lane)
    path = _validate_stem_path(job_id, lane)
    spec = await _until_done(request, analysis(job_id, lane, path))
    return await asyncio.to_thread(_answer, spec, chosen, PANEL_LAYOUTS[panel], mode, current)
