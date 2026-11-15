"""The studio EQ and the master in the exports: the ``fx=`` and ``master=``
parameters of GET mixdown.{ext} and video.mp4, turned into ffmpeg filters.

Per input, the lane's EQ runs first (before the pitch shift, as the live
engine's EQ slot sits between the lane gain and the pitch bus); after the sum,
the master EQ and then the master chain (glue compressor, planned gain, true
peak limiter, trim). The click joins the sum before the master chain, as it
does live, but carries no lane EQ and is left out of the loudness measurement:
the loudness is set for the music, not the practice aid. Each piece of an
"original" lane rebuilt from its component stems gets the "original" EQ.

With no EQ that changes the sound and no master, the graph and the render
cache key carry nothing of either, so such an export is bit-identical to one
that never names them. Everything that reaches the graph is formatted by
app/pipeline/fx_filters.py and app/pipeline/mastering.py from validated
numbers; every refusal is a 422 with a message safe to show.

The master is measured on the whole song at the export rate (the plan is kept
by app/pipeline/master_plan_cache.py), so a region export gets the full
master's gain. A lossy encoder adds peak the graph cannot see, so a mastered
mp3, ogg or video is decoded and measured, and rendered again with a deeper
trim while it is over its capped ceiling. The response carries the final
measurement as X-StemDeck-* headers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import NamedTuple, Protocol, TypeVar

import soundfile as sf
from fastapi import HTTPException, Query

from app.core.config import FX_PARAM_MAX_CHARS, MASTER_CEILING_RETRIES, MASTER_PARAM_MAX_CHARS
from app.core.settings import DEFAULT_EXPORT_SAMPLE_RATE, get_export_sample_rate
from app.pipeline import master_plan_cache
from app.pipeline.fx_filters import (
    Eq,
    FxError,
    FxRequest,
    check_section_budget,
    parse_fx_param,
    slot_filter,
    slot_section_count,
)
from app.pipeline.master_ceiling import Tries, correction_step, loudness_miss, overshoot_db
from app.pipeline.master_plan_cache import cached_plan
from app.pipeline.mastering import (
    LOGGER_NAME,
    LOSSY_FORMATS,
    Loudness,
    MasterError,
    MasterPlan,
    MasterSettings,
    MeasureError,
    measure_chain,
    parse_master_param,
    plan_chain,
    plan_graph,
    require_master_param,
    target_reached,
)

logger = logging.getLogger("stemdeck.api")
mastering_logger = logging.getLogger(LOGGER_NAME)

MEASURE_FAILED_DETAIL = "mastering measurement failed"
FX_KEY_PREFIX = "fx:"
MASTER_KEY_PREFIX = "m:"
KEY_PART_SEPARATOR = "|"
KEY_MASTER_EQ_SEPARATOR = "#"
HEADER_LOUDNESS_PRE = "X-StemDeck-Loudness-Pre"
HEADER_LOUDNESS_POST = "X-StemDeck-Loudness-Post"
HEADER_MASTER_GAIN = "X-StemDeck-Master-Gain"
HEADER_TARGET_REACHED = "X-StemDeck-Target-Reached"
REACHED_YES = "1"
REACHED_NO = "0"
FX_DESCRIPTION = "The studio EQ: base64url JSON (docs/api.md). Empty means no EQ."
MASTER_DESCRIPTION = "The master: base64url JSON (docs/api.md). Empty means no master."
FILTER_COMPLEX = "-filter_complex"
DECODED_GRAPH = "[0:a]anull[pre]"
_OUTPUT_NOTE_PREFIX = "out-"
_NO_VALUE = "none"
_MIX_LABEL = "[mix]"
_SINGLE_LABEL = "[a0]"

T = TypeVar("T")
Render = Callable[..., Awaitable[Path]]


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
        lanes = KEY_PART_SEPARATOR.join(self.lanes)
        return f"{FX_KEY_PREFIX}{lanes}{KEY_MASTER_EQ_SEPARATOR}{self.master}"


class ExportFx(NamedTuple):
    """One export's EQ and master: the filter prefixes, the measured plan
    (None with no master), the chain the render runs after the master EQ and
    the rate that chain limits at."""

    render_fx: RenderFx
    plan: MasterPlan | None
    chain: str
    rate: int

    def prefix(self, index: int) -> str:
        return self.render_fx.prefix(index)

    def tail(self) -> str:
        """What runs on the sum: the master EQ, then the master chain."""
        parts = [self.render_fx.master.rstrip(","), self.chain]
        return ",".join(p for p in parts if p)

    def cache_suffix(self) -> str:
        """Appended to the render cache key, "" with no EQ and no master."""
        parts = [self.render_fx.key_fragment()]
        if self.plan is not None:
            parts.append(MASTER_KEY_PREFIX + self.chain)
        return KEY_PART_SEPARATOR.join(p for p in parts if p)

    def verifies(self, output_format: str) -> bool:
        """Whether the encoded file is decoded and checked against the ceiling."""
        return self.plan is not None and output_format in LOSSY_FORMATS

    def headers(self, out: Loudness | None = None) -> dict[str, str]:
        """The loudness before and after the master; ``out`` is the decoded
        file's own measurement when there is one, else the plan's."""
        if self.plan is None:
            return {}
        plan = self.plan
        post = out or plan.post
        reached = plan.reached if out is None else target_reached(plan.target, plan.ceiling, out)
        return {
            HEADER_LOUDNESS_PRE: f"i={_fmt(plan.pre.i)};tp={_fmt(plan.pre.tp)}",
            HEADER_LOUDNESS_POST: f"i={_fmt(post.i)};tp={_fmt(post.tp)}",
            HEADER_MASTER_GAIN: f"{plan.gain_db:.2f}",
            HEADER_TARGET_REACHED: REACHED_YES if reached else REACHED_NO,
        }


def _fmt(value: float | None) -> str:
    return _NO_VALUE if value is None else f"{value:.2f}"


def fx_query():
    return Query(max_length=FX_PARAM_MAX_CHARS, description=FX_DESCRIPTION)


def master_query():
    return Query(max_length=MASTER_PARAM_MAX_CHARS, description=MASTER_DESCRIPTION)


def _as_422(parse: Callable[..., T], *args: object) -> T:
    try:
        return parse(*args)
    except (FxError, MasterError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from None


def input_rate(path: Path) -> int:
    """The rate the EQ is designed at: the file's own, since the filter runs
    on its decoded samples before any resample to the export rate."""
    try:
        return int(sf.info(str(path)).samplerate)
    except (RuntimeError, OSError):
        logger.debug("could not read the sample rate of %s", path, exc_info=True)
        return DEFAULT_EXPORT_SAMPLE_RATE


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
    _as_422(check_section_budget, sections + slot_section_count(fx_req.master))
    return RenderFx(prefixes, master)


def lane_chain(eq: str, pitch: str, gain: float, delay: str = "") -> str:
    """One input's chain as both the render and the measurement run it:
    EQ, pitch shift, the count-in delay (render only), gain."""
    return f"{eq}{pitch}{delay}volume={gain:.6f}"


async def _measured_plan(
    lanes: Sequence[RenderLaneLike],
    render_fx: RenderFx,
    settings: MasterSettings,
    output_format: str,
    pitch_filter: Callable[[int], str],
) -> tuple[MasterPlan, int]:
    """The whole song's master for these music lanes, and the rate it runs at."""
    rate = get_export_sample_rate()
    chains = [
        lane_chain(render_fx.prefix(i), pitch_filter(lane.pitch), lane.gain)
        for i, lane in enumerate(lanes)
    ]
    graph = plan_graph(chains, render_fx.master)
    paths = [lane.path for lane in lanes]
    try:
        return await cached_plan(paths, graph, settings, output_format, rate), rate
    except MeasureError as exc:
        mastering_logger.warning("%s: %s", MEASURE_FAILED_DETAIL, exc)
        raise HTTPException(status_code=500, detail=MEASURE_FAILED_DETAIL) from None


async def prepare_export(
    lanes: Sequence[RenderLaneLike],
    fx: str,
    master: str,
    output_format: str,
    pitch_filter: Callable[[int], str],
    master_required: bool = False,
) -> ExportFx:
    """Validate ``fx`` and ``master`` (422), build the EQ and measure the master."""
    fx_req = _as_422(parse_fx_param, fx)
    parse_master = require_master_param if master_required else parse_master_param
    settings = _as_422(parse_master, master)
    render_fx = await asyncio.to_thread(build_render_fx, lanes, fx_req)
    if settings is None:
        return ExportFx(render_fx, None, "", 0)
    plan, rate = await _measured_plan(lanes, render_fx, settings, output_format, pitch_filter)
    return ExportFx(render_fx, plan, plan_chain(plan, rate), rate)


def sum_filter(count: int, tail: str) -> tuple[str | None, str]:
    """The filter summing inputs [a0]..[a{count-1}] through ``tail``, and the
    label to map. With no tail: amix (normalize=0) for several inputs, a
    single input mapped as it is."""
    if count > 1:
        labels = "".join(f"[a{i}]" for i in range(count))
        chain = f",{tail}" if tail else ""
        return f"{labels}amix=inputs={count}:normalize=0{chain}{_MIX_LABEL}", _MIX_LABEL
    if tail:
        return f"{_SINGLE_LABEL}{tail}{_MIX_LABEL}", _MIX_LABEL
    return None, _SINGLE_LABEL


async def measure_file(path: str, rate: int) -> Loudness:
    """Loudness and true peak of a rendered file as a player decodes it. Raises MeasureError."""
    return await measure_chain(["-i", path], DECODED_GRAPH, "", rate)


def with_chain(cmd: list[str], chain: str, replacement: str) -> list[str]:
    """``cmd`` with the master ``chain`` in its filter graph swapped for ``replacement``."""
    if chain == replacement:
        return cmd
    i = cmd.index(FILTER_COMPLEX) + 1
    return [*cmd[:i], cmd[i].replace(chain, replacement, 1), *cmd[i + 1 :]]


def _note_path(cache_path: Path) -> Path:
    return master_plan_cache.MASTER_PLAN_CACHE_DIR / f"{_OUTPUT_NOTE_PREFIX}{cache_path.name}.json"


def _write_note(cache_path: Path, out: Loudness) -> None:
    note = _note_path(cache_path)
    note.parent.mkdir(parents=True, exist_ok=True)
    tmp = note.with_name(f".{note.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(asdict(out)), encoding="utf-8")
    os.replace(tmp, note)


def _read_note(cache_path: Path) -> Loudness | None:
    try:
        return Loudness(**json.loads(_note_path(cache_path).read_text(encoding="utf-8")))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError):
        logger.debug("unreadable output note for %s", cache_path, exc_info=True)
        return None


async def stored_output(export: ExportFx, output_format: str, cache_path: Path) -> Loudness | None:
    """A cached verified render's decoded measurement, None when there is none."""
    if not export.verifies(output_format) or not cache_path.is_file():
        return None
    return await asyncio.to_thread(_read_note, cache_path)


async def _decoded(path: Path, context: str) -> Loudness:
    try:
        return await measure_file(str(path), get_export_sample_rate())
    except MeasureError as exc:
        path.unlink(missing_ok=True)
        mastering_logger.warning("%s [%s]: %s", MEASURE_FAILED_DETAIL, context, exc)
        raise HTTPException(status_code=500, detail=MEASURE_FAILED_DETAIL) from None


async def render_verified(
    export: ExportFx,
    cmd: list[str],
    suffix: str,
    context: str,
    render: Render,
    cache_path: Path | None = None,
) -> tuple[Path, Loudness]:
    """Render a mastered lossy export, decode it, and correct it as
    app/pipeline/master_ceiling.py does in-graph: lower limit, gain following
    the target, a trim as the last resort. Returns the file (the cache entry,
    or a temp file the caller removes) and its decoded measurement."""
    plan = export.plan
    gain = offset = trim = 0.0
    tried: Tries = []
    for attempt in range(MASTER_CEILING_RETRIES + 2):
        chain = plan_chain(plan, export.rate, offset, trim, gain)
        path = await render(with_chain(cmd, export.chain, chain), suffix, context, cache_path)
        out = await _decoded(path, context)
        over = overshoot_db(out.tp, plan.ceiling)
        miss = loudness_miss(plan.target, out) if offset or over else 0.0
        tried.append((gain, out.i))
        settled = not over and (not miss or attempt == MASTER_CEILING_RETRIES)
        if settled or trim:
            break
        if attempt < MASTER_CEILING_RETRIES:
            if over:
                offset, tried = offset + over, []
            gain += correction_step(miss, tried)
        else:
            trim = over
        if cache_path is None:
            path.unlink(missing_ok=True)
    if over:
        mastering_logger.warning("still over the ceiling after %d retries [%s]", attempt, context)
    if cache_path is not None:
        await asyncio.to_thread(_write_note, cache_path, out)
    return path, out
