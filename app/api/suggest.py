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

``GET /api/jobs/{id}/suggest/master?stems=&gains=&pitches=&fx=&target=&mode=``
measures the mix as the export sums it (lanes, their EQ, pitch and gain, a
take's limiter; no click, no master EQ), through export_fx's own measurement
graph, and answers as the lane route does for the master EQ's graph panel,
plus ``master``: the loudness preset the mix allows. The mix's spectrum and
its loudness are cached together, keyed by the graph and the files' stats.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import logging
from collections import deque
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass
from functools import partial
from pathlib import Path
from typing import Annotated, TypeVar

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request

from app.api import takes_lanes
from app.api.export_fx import (
    FILTER_COMPLEX,
    RenderLaneLike,
    build_render_fx,
    fx_query,
    lane_chain,
    measurement_graph,
)
from app.api.stems import (
    _MIXDOWN_NAMES,
    NO_TRANSPOSE_DETAIL,
    PITCHES_MAX_CHARS,
    _drain_stderr,
    _expand_render_lanes,
    _parse_lane_gains,
    _parse_pitches,
    _pitch_filter,
    _rubberband_available,
    _validate_stem_path,
)
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
from app.core.settings import get_export_sample_rate
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
    recommend_master,
)
from app.pipeline.eq_targets import (
    BALANCED_VARIANT,
    LANE_USE,
    MIX_USE,
    Target,
    default_target,
    get_target,
    targets_for_use,
)
from app.pipeline.fx_filters import Eq, FxError, FxRequest, parse_fx_param
from app.pipeline.master_plan_cache import keyed_lock, read_cache, write_cache
from app.pipeline.mastering import _STDERR_TAIL_LINES, Loudness, MeasureError, measure_chain

logger = logging.getLogger("stemdeck.suggest")

router = APIRouter(tags=["suggest"])

T = TypeVar("T")

CACHE_VERSION = "1"
ANALYSIS_FAILED = "analysis failed"
MASTER_DEFAULT_TARGET = f"{MIX_USE}.{BALANCED_VARIANT}"
_MASTER_KEY = "master"
_PRE_LABEL = "[pre]"
_NO_MASTER_EQ = ""
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


def _decode_cmd(source: list[str]) -> list[str]:
    """``source``: the inputs and the -map of the audio to analyse."""
    return [
        *(ffmpeg_executable(), "-nostdin", "-hide_banner", "-nostats", "-loglevel", "error"),
        *source,
        *("-ac", str(CHANNELS), "-ar", str(ANALYSIS_RATE)),
        *("-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"),
    ]


def _file_source(path: Path) -> list[str]:
    return ["-i", str(path), "-map", "0:a:0"]


def _graph_source(inputs: list[str], graph: str) -> list[str]:
    return [*inputs, FILTER_COMPLEX, graph, "-map", _PRE_LABEL]


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


async def _run_analysis(source: list[str]) -> Spectrum:
    """Decode ``source`` to float stereo at the analysis rate, streamed into the
    gated spectrum. Raises AnalysisError."""
    proc = await asyncio.create_subprocess_exec(
        *_decode_cmd(source),
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


@dataclass(frozen=True)
class MixAnalysis:
    """The mix's gated spectrum and its loudness (ebur128, as the master measures)."""

    spectrum: Spectrum
    loudness: Loudness

    def to_json(self) -> dict:
        return {"spectrum": spectrum_to_json(self.spectrum), "loudness": asdict(self.loudness)}

    @classmethod
    def from_json(cls, data: dict) -> MixAnalysis:
        return cls(spectrum_from_json(data["spectrum"]), Loudness(**data["loudness"]))


def _read(path: Path, from_json: Callable[[dict], T]) -> T | None:
    data = read_cache(path)
    try:
        return None if data is None else from_json(data)
    except (KeyError, TypeError, ValueError):
        logger.debug("unreadable suggest cache %s", path, exc_info=True)
        return None


def _cache_path(parts: list[str], paths: Sequence[Path]) -> Path:
    """Keyed by ``parts`` and each file's path, size and mtime."""
    files = [f"{p}@{p.stat().st_size}:{p.stat().st_mtime_ns}" for p in paths]
    raw = "|".join([CACHE_VERSION, *parts, *files])
    key = hashlib.sha1(raw.encode("utf-8"), usedforsecurity=False).hexdigest()
    return SUGGEST_CACHE_DIR / f"{key}.json"


async def _measured(job_id: str, measure: Callable[[], Awaitable[T]]) -> T:
    async with _analysis_slots:
        try:
            return await measure()
        except (AnalysisError, MeasureError) as exc:
            logger.warning("suggest analysis failed [job=%s]: %s", job_id, exc)
            raise HTTPException(status_code=500, detail=ANALYSIS_FAILED) from None


async def _cached(
    cache: Path,
    job_id: str,
    measure: Callable[[], Awaitable[T]],
    from_json: Callable[[dict], T],
    to_json: Callable[[T], dict],
) -> T:
    """The cached value, measured now when absent; one key is never measured twice at once."""
    async with keyed_lock(_analysis_locks, cache.stem):
        cached = await asyncio.to_thread(_read, cache, from_json)
        if cached is not None:
            return cached
        value = await _measured(job_id, measure)
        await asyncio.to_thread(write_cache, cache, to_json(value), SUGGEST_CACHE_MAX_FILES)
        return value


async def analysis(job_id: str, lane: str, path: Path) -> Spectrum:
    """The cached spectrum of the lane's file, measured now when absent."""
    cache = await asyncio.to_thread(_cache_path, [job_id, lane], [path])
    measure = partial(_run_analysis, _file_source(path))
    return await _cached(cache, job_id, measure, spectrum_from_json, spectrum_to_json)


async def _measure_mix(inputs: list[str], graph: str) -> MixAnalysis:
    spectrum = await _run_analysis(_graph_source(inputs, graph))
    loudness = await measure_chain(inputs, graph, "", get_export_sample_rate())
    return MixAnalysis(spectrum, loudness)


async def mix_analysis(job_id: str, paths: list[Path], graph: str) -> MixAnalysis:
    """The cached spectrum and loudness of ``graph`` over ``paths`` (input i is paths[i])."""
    cache = await asyncio.to_thread(_cache_path, [job_id, _MASTER_KEY, graph], paths)
    inputs = [arg for p in paths for arg in ("-i", str(p))]
    measure = partial(_measure_mix, inputs, graph)
    return await _cached(cache, job_id, measure, MixAnalysis.from_json, MixAnalysis.to_json)


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


def _fx_request(fx: str) -> FxRequest:
    try:
        return parse_fx_param(fx)
    except FxError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


def _current_eq(fx: str, lane: str) -> Eq | None:
    return (_fx_request(fx).lanes.get(lane) or [None])[0]


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


def _master_target(target: str) -> Target:
    chosen = get_target(target or MASTER_DEFAULT_TARGET)
    if chosen is None or chosen.use != MIX_USE:
        raise HTTPException(status_code=422, detail="unknown target")
    return chosen


async def _mix_lanes(job_id: str, stems: str, gains: str, pitches: str) -> list[RenderLaneLike]:
    """The export's lanes for this mix: the same parsing, takes and refusals."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    names, parsed_gains = _parse_lane_gains(stems, gains)
    parsed_pitches = takes_lanes.zero_take_pitches(names, _parse_pitches(pitches, names))
    if any(parsed_pitches) and not await asyncio.to_thread(_rubberband_available):
        raise HTTPException(status_code=422, detail=NO_TRANSPOSE_DETAIL)
    lanes, _unpitched = _expand_render_lanes(job_id, names, parsed_gains, parsed_pitches)
    return lanes


def _mix_graph(lanes: Sequence[RenderLaneLike], fx_req: FxRequest) -> str:
    """The export's measurement graph for ``lanes``, without the click or the master EQ."""
    render_fx = build_render_fx(lanes, fx_req)
    chains = [
        lane_chain(render_fx.prefix(i), _pitch_filter(lane.pitch), lane.gain)
        for i, lane in enumerate(lanes)
    ]
    return measurement_graph(chains, [lane.name for lane in lanes], _NO_MASTER_EQ)


def _master_answer(mix: MixAnalysis, chosen: Target, mode: str, current: Eq | None) -> dict:
    body = _answer(mix.spectrum, chosen, PANEL_LAYOUTS[GRAPH_PANEL], mode, current)
    master = recommend_master(mix.loudness.i, mix.loudness.tp, chosen.target_lufs)
    body["reasons"].append(master.reason)
    return {**body, "master": master.to_json()}


@router.get("/jobs/{job_id}/suggest/master")
async def suggest_master(
    request: Request,
    job_id: str,
    stems: str = Query(..., description="Comma-separated lane names, as for mixdown"),
    gains: str = Query(..., description="Comma-separated linear gains, parallel to stems"),
    pitches: str = Query("", max_length=PITCHES_MAX_CHARS, description="As for mixdown"),
    fx: Annotated[str, fx_query()] = "",
    target: str = Query("", max_length=_TARGET_MAX_CHARS, description="Mix target id"),
    mode: str = Query(REPLACE, max_length=_CHOICE_MAX_CHARS, description="replace or merge"),
) -> dict:
    """Measure the mix as the export sums it (before the master EQ) and suggest
    master EQ bands toward a mix target, plus the loudness preset it allows."""
    chosen = _master_target(target)
    if mode not in MODES:
        raise HTTPException(status_code=422, detail="unknown mode")
    fx_req = _fx_request(fx)
    lanes = await _mix_lanes(job_id, stems, gains, pitches)
    graph = await asyncio.to_thread(_mix_graph, lanes, fx_req)
    paths = [lane.path for lane in lanes]
    mix = await _until_done(request, mix_analysis(job_id, paths, graph))
    current = (fx_req.master or [None])[0]
    return await asyncio.to_thread(_master_answer, mix, chosen, mode, current)
