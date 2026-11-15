"""The studio EQ and the master in the exports: the ``fx=`` and ``master=``
parameters of GET mixdown.{ext} and video.mp4, turned into ffmpeg filters.

Per input, the lane's EQ runs first (before the pitch shift, as the live
engine's EQ slot sits between the lane gain and the pitch bus); after the sum,
the master EQ and then the master chain (glue compressor, planned gain, true
peak limiter). The click joins the sum before the master chain, as it does
live, but carries no lane EQ and is left out of the loudness measurement:
the loudness is set for the music, not the practice aid. Each piece of an
"original" lane rebuilt from its component stems gets the "original" EQ.

An export with no EQ that changes the sound and no master builds exactly the
graph and the cache key it built before either existed, so cached renders
stay valid and the file is bit-identical. Everything that reaches the graph
is formatted by app/pipeline/fx_filters.py and app/pipeline/mastering.py from
validated numbers; every refusal here is a 422 with a message safe to show.

The master is measured on the whole song (app/pipeline/master_plan_cache.py
keeps the plan on disk), so a region export gets the full master's gain. The
response then carries the measurement as X-StemDeck-* headers.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import NamedTuple, Protocol

import soundfile as sf
from fastapi import HTTPException, Query

from app.core.config import FX_FALLBACK_SAMPLE_RATE, FX_PARAM_MAX_CHARS, MASTER_PARAM_MAX_CHARS
from app.pipeline.fx_filters import (
    Eq,
    FxError,
    FxRequest,
    check_section_budget,
    parse_fx_param,
    slot_filter,
    slot_section_count,
)
from app.pipeline.master_plan_cache import cached_plan
from app.pipeline.mastering import (
    LOGGER_NAME,
    MasterError,
    MasterPlan,
    MasterSettings,
    MeasureError,
    parse_master_param,
    plan_chain,
    plan_graph,
    require_master_param,
)

logger = logging.getLogger("stemdeck.api")
mastering_logger = logging.getLogger(LOGGER_NAME)

HTTP_UNPROCESSABLE = 422
HTTP_MEASURE_FAILED = 500
MEASURE_FAILED_DETAIL = "mastering measurement failed"
FX_KEY_PREFIX = "fx:"
MASTER_KEY_PREFIX = "m:"
HEADER_LOUDNESS_PRE = "X-StemDeck-Loudness-Pre"
HEADER_LOUDNESS_POST = "X-StemDeck-Loudness-Post"
HEADER_MASTER_GAIN = "X-StemDeck-Master-Gain"
HEADER_TARGET_REACHED = "X-StemDeck-Target-Reached"
FX_DESCRIPTION = "The studio EQ: base64url JSON (docs/api.md). Empty means no EQ."
MASTER_DESCRIPTION = "The master: base64url JSON (docs/api.md). Empty means no master."
_NO_VALUE = "none"
_MIX_LABEL = "[mix]"
_SINGLE_LABEL = "[a0]"


class RenderLaneLike(Protocol):
    """What this module reads of a render lane (app/api/stems.py _RenderLane)."""

    @property
    def path(self) -> Path: ...

    @property
    def gain(self) -> float: ...

    @property
    def pitch(self) -> int: ...

    @property
    def name(self) -> str: ...


class RenderFx(NamedTuple):
    """Filter prefixes ("" or a chain ending in a comma): one per input, by
    its lane, and one for the master EQ after the sum."""

    lanes: list[str]
    master: str

    def prefix(self, index: int) -> str:
        """Input ``index``'s EQ prefix; inputs past the music lanes (the click) have none."""
        return self.lanes[index] if index < len(self.lanes) else ""

    def key_fragment(self) -> str:
        if not self.master and not any(self.lanes):
            return ""
        return FX_KEY_PREFIX + "|".join(self.lanes) + "#" + self.master


class MasteredMix(NamedTuple):
    """The measured plan and the chain the render runs after the master EQ."""

    plan: MasterPlan
    chain: str


def fx_query():
    return Query(max_length=FX_PARAM_MAX_CHARS, description=FX_DESCRIPTION)


def master_query():
    return Query(max_length=MASTER_PARAM_MAX_CHARS, description=MASTER_DESCRIPTION)


def parse_fx_query(raw: str) -> FxRequest:
    try:
        return parse_fx_param(raw)
    except FxError as exc:
        raise HTTPException(status_code=HTTP_UNPROCESSABLE, detail=str(exc)) from None


def parse_master_query(raw: str) -> MasterSettings | None:
    try:
        return parse_master_param(raw)
    except MasterError as exc:
        raise HTTPException(status_code=HTTP_UNPROCESSABLE, detail=str(exc)) from None


def require_master_query(raw: str) -> MasterSettings:
    try:
        return require_master_param(raw)
    except MasterError as exc:
        raise HTTPException(status_code=HTTP_UNPROCESSABLE, detail=str(exc)) from None


def input_rate(path: Path) -> int:
    """The rate the EQ is designed at: the file's own, since the filter runs
    on its decoded samples before any resample to the export rate."""
    try:
        return int(sf.info(str(path)).samplerate)
    except (RuntimeError, OSError):
        logger.debug("could not read the sample rate of %s", path, exc_info=True)
        return FX_FALLBACK_SAMPLE_RATE


def _slot_prefix(effects: list[Eq], path: Path) -> str:
    if not effects:
        return ""
    chain = slot_filter(effects, input_rate(path))
    return f"{chain}," if chain else ""


def build_render_fx(lanes: Sequence[RenderLaneLike], fx_req: FxRequest) -> RenderFx:
    """Each lane's EQ by its name, and the master EQ at the first input's
    rate (the rate amix runs at). 422 past the biquad budget."""
    prefixes = []
    sections = 0
    for lane in lanes:
        effects = fx_req.lanes.get(lane.name, []) if lane.name else []
        prefixes.append(_slot_prefix(effects, lane.path))
        sections += slot_section_count(effects)
    master = _slot_prefix(fx_req.master, lanes[0].path) if lanes else ""
    sections += slot_section_count(fx_req.master)
    try:
        check_section_budget(sections)
    except FxError as exc:
        raise HTTPException(status_code=HTTP_UNPROCESSABLE, detail=str(exc)) from None
    return RenderFx(prefixes, master)


async def plan_master(
    lanes: Sequence[RenderLaneLike],
    render_fx: RenderFx,
    settings: MasterSettings | None,
    output_format: str,
    pitch_filter: Callable[[int], str],
) -> MasteredMix | None:
    """The whole song's measured master for these music lanes, None when off.
    Each lane is measured as the export runs it: EQ, pitch shift, gain."""
    if settings is None:
        return None
    paths = [lane.path for lane in lanes]
    rate = await asyncio.to_thread(input_rate, paths[0])
    chains = [
        f"{render_fx.prefix(i)}{pitch_filter(lane.pitch)}volume={lane.gain:.6f}"
        for i, lane in enumerate(lanes)
    ]
    graph = plan_graph(chains, render_fx.master)
    try:
        plan = await cached_plan(paths, graph, settings, output_format, rate)
    except MeasureError as exc:
        mastering_logger.warning("%s: %s", MEASURE_FAILED_DETAIL, exc)
        raise HTTPException(status_code=HTTP_MEASURE_FAILED, detail=MEASURE_FAILED_DETAIL) from None
    return MasteredMix(plan, plan_chain(plan, rate))


def mix_tail(render_fx: RenderFx, mastered: MasteredMix | None) -> str:
    """What runs on the sum: the master EQ, then the master chain."""
    parts = [render_fx.master.rstrip(","), mastered.chain if mastered else ""]
    return ",".join(p for p in parts if p)


def sum_filter(count: int, tail: str) -> tuple[str | None, str]:
    """The filter summing inputs [a0]..[a{count-1}] through ``tail``, and the
    label to map. With no tail, the graph exports always had: amix
    (normalize=0) for several inputs, a single input mapped as it is."""
    if count > 1:
        labels = "".join(f"[a{i}]" for i in range(count))
        chain = f",{tail}" if tail else ""
        return f"{labels}amix=inputs={count}:normalize=0{chain}{_MIX_LABEL}", _MIX_LABEL
    if tail:
        return f"{_SINGLE_LABEL}{tail}{_MIX_LABEL}", _MIX_LABEL
    return None, _SINGLE_LABEL


def cache_key_suffix(render_fx: RenderFx, mastered: MasteredMix | None) -> str:
    """Appended to the render cache key, "" with no EQ and no master."""
    parts = [render_fx.key_fragment()]
    if mastered is not None:
        parts.append(MASTER_KEY_PREFIX + mastered.chain)
    return "|".join(p for p in parts if p)


def _fmt(value: float | None) -> str:
    return _NO_VALUE if value is None else f"{value:.2f}"


def master_headers(mastered: MasteredMix | None) -> dict[str, str]:
    """The measured loudness before and after the master, for API clients."""
    if mastered is None:
        return {}
    plan = mastered.plan
    return {
        HEADER_LOUDNESS_PRE: f"i={_fmt(plan.pre.i)};tp={_fmt(plan.pre.tp)}",
        HEADER_LOUDNESS_POST: f"i={_fmt(plan.post.i)};tp={_fmt(plan.post.tp)}",
        HEADER_MASTER_GAIN: f"{plan.gain_db:.2f}",
        HEADER_TARGET_REACHED: "1" if plan.reached else "0",
    }
