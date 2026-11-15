"""The studio EQ and the master in the exports: the ``fx=`` and ``master=``
parameters of GET mixdown.{ext} and video.mp4, turned into ffmpeg filters.

Per input, the lane's EQ runs first (before the pitch shift, as live); after
the sum, the master EQ and then the master chain (glue compressor, planned
gain, true peak limiter, trim). The click joins the sum before the master
chain, as it does live, with no lane EQ. The loudness is set for the music, so
the click is measured only where a take's limiter has already summed the two.

With no EQ that changes the sound and no master, the graph and the render
cache key carry nothing of either, so such an export is bit-identical to one
that never names them. Everything that reaches the graph is formatted by
app/pipeline/fx_filters.py and app/pipeline/mastering.py from validated
numbers; every refusal is a 422 with a message safe to show.

The master is measured on the whole song at the export rate (the plan is kept
by app/pipeline/master_plan_cache.py), so a region gets the full master's
gain. A lossy encoder adds peak the graph cannot see, so a mastered mp3, ogg or
video is decoded, measured and rendered again with a lower limit while over
its capped ceiling. Only a verified render reaches the render cache, its
decoded measurement in a note beside it. The response carries the final
measurement as X-StemDeck-* headers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import NamedTuple, Protocol, TypeVar

import soundfile as sf
from fastapi import HTTPException, Query

from app.api import takes_lanes
from app.api.export_graph import lane_chain as lane_chain
from app.api.export_graph import lanes_graph
from app.api.export_graph import measurement_graph as measurement_graph
from app.core.config import FX_PARAM_MAX_CHARS, MASTER_CEILING_RETRIES, MASTER_PARAM_MAX_CHARS
from app.core.settings import DEFAULT_EXPORT_SAMPLE_RATE, get_export_sample_rate
from app.pipeline.fx_filters import (
    Eq,
    FxError,
    FxRequest,
    check_section_budget,
    parse_fx_param,
    slot_filter,
    slot_section_count,
)
from app.pipeline.master_ceiling import Tries, correction_step, missed, overshoot_db
from app.pipeline.master_plan_cache import cached_plan, read_cache
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
OUTPUT_NOTE_SUFFIX = ".out.json"
HTTP_CLIENT_GONE = 499
CLIENT_GONE_DETAIL = "client went away"
_NO_VALUE = "none"

T = TypeVar("T")
Render = Callable[..., Awaitable[Path]]
Gone = Callable[[], Awaitable[bool]]


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
    the rate that chain limits at. A region is held to the song's plan."""

    render_fx: RenderFx
    plan: MasterPlan | None
    chain: str
    rate: int
    region: bool = False

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
        file's own measurement when there is one, else (and for a region) the plan's."""
        if self.plan is None:
            return {}
        plan = self.plan
        measured = out is not None and not self.region
        post = out if measured else plan.post
        reached = target_reached(plan.target, plan.ceiling, out) if measured else plan.reached
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


class ClickInput(NamedTuple):
    """The whole song's click as the render sums it: its file and level filter."""

    path: Path
    level: str


async def _measured_plan(
    lanes: Sequence[RenderLaneLike],
    render_fx: RenderFx,
    settings: MasterSettings,
    output_format: str,
    pitch_filter: Callable[[int], str],
    click: ClickInput | None,
) -> tuple[MasterPlan, int]:
    """The whole song's master for these lanes (and ``click``), and the rate it runs at."""
    rate = get_export_sample_rate()
    level = None if click is None else click.level
    graph = lanes_graph(lanes, render_fx, pitch_filter, render_fx.master, level)
    paths = [lane.path for lane in lanes] + ([] if click is None else [click.path])
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
    region: bool = False,
    click: ClickInput | None = None,
) -> ExportFx:
    """Validate ``fx`` and ``master`` (422), build the EQ and measure the master.
    ``click`` is measured with the music only when the caller gives it: when a
    take's limiter sums the two, the click cannot be taken back out."""
    fx_req = _as_422(parse_fx_param, fx)
    parse_master = require_master_param if master_required else parse_master_param
    settings = _as_422(parse_master, master)
    render_fx = await asyncio.to_thread(build_render_fx, lanes, fx_req)
    if settings is None:
        return ExportFx(render_fx, None, "", 0)
    plan, rate = await _measured_plan(
        lanes,
        render_fx,
        settings,
        output_format,
        pitch_filter,
        click,
    )
    return ExportFx(render_fx, plan, plan_chain(plan, rate), rate, region)


def attach_tail(filters: list[str], out_label: str, tail: str) -> str:
    """Run ``tail`` (master EQ, master chain) on the summed output labelled
    ``out_label``, the last filter's output, and return the label to map. With
    no tail, the graph is left exactly as it is."""
    if not tail:
        return out_label
    mix = takes_lanes.MIX_LABEL
    if out_label == mix:
        filters[-1] = f"{filters[-1].removesuffix(mix)},{tail}{mix}"
    else:
        filters.append(f"{out_label}{tail}{mix}")
    return mix


async def measure_file(path: str, rate: int) -> Loudness:
    """Loudness and true peak of a rendered file as a player decodes it. Raises MeasureError."""
    return await measure_chain(["-i", path], DECODED_GRAPH, "", rate)


def with_chain(cmd: list[str], chain: str, replacement: str) -> list[str]:
    """``cmd`` with the master ``chain`` in its filter graph swapped for ``replacement``."""
    if chain == replacement:
        return cmd
    i = cmd.index(FILTER_COMPLEX) + 1
    return [*cmd[:i], cmd[i].replace(chain, replacement, 1), *cmd[i + 1 :]]


def note_path(entry: Path) -> Path:
    """Where a verified cache entry's decoded measurement is kept: beside it."""
    return entry.with_name(entry.name + OUTPUT_NOTE_SUFFIX)


def _write_note(entry: Path, out: Loudness) -> None:
    note = note_path(entry)
    note.parent.mkdir(parents=True, exist_ok=True)
    tmp = note.with_name(f".{note.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(asdict(out)), encoding="utf-8")
        os.replace(tmp, note)
    finally:
        tmp.unlink(missing_ok=True)


def _read_note(entry: Path) -> Loudness | None:
    body = read_cache(note_path(entry))
    try:
        return None if body is None else Loudness(**body)
    except TypeError:
        logger.debug("unreadable output note for %s", entry, exc_info=True)
        return None


def _drop(entry: Path) -> None:
    entry.unlink(missing_ok=True)
    note_path(entry).unlink(missing_ok=True)


async def _remeasured(export: ExportFx, entry: Path) -> Loudness | None:
    try:
        out = await measure_file(str(entry), get_export_sample_rate())
    except MeasureError as exc:
        mastering_logger.warning("%s [%s]: %s", MEASURE_FAILED_DETAIL, entry.name, exc)
        out = None
    if out is None or overshoot_db(out.tp, export.plan.ceiling) or not entry.is_file():
        await asyncio.to_thread(_drop, entry)
        return None
    await asyncio.to_thread(_write_note, entry, out)
    return out


async def cached_output(
    export: ExportFx,
    output_format: str,
    entry: Path,
) -> tuple[bool, Loudness | None]:
    """Whether ``entry`` can be served, and a verified one's decoded measurement.
    A verified entry with no note is measured again; one over its ceiling is dropped."""
    if not entry.is_file():
        return False, None
    if not export.verifies(output_format):
        return True, None
    out = await asyncio.to_thread(_read_note, entry)
    if out is None:
        out = await _remeasured(export, entry)
    return out is not None, out


def publish(
    path: Path,
    out: Loudness,
    entry: Path,
    prune: Callable[..., None],
) -> Path:
    """Move a verified render into the cache as ``entry``, its note written first."""
    try:
        _write_note(entry, out)
        os.replace(path, entry)
    except OSError:
        path.unlink(missing_ok=True)
        _drop(entry)
        raise
    prune(entry.parent, keep=entry)
    return entry


class VerifyJob(NamedTuple):
    """A lossy export to verify: ffmpeg command (no output path), suffix, log
    context, renderer to a temp file, and whether the client has gone."""

    cmd: list[str]
    suffix: str
    context: str
    render: Render
    gone: Gone


@dataclass
class _Correction:
    """The decoded-file loop's settings, and the (gain, loudness) tries since
    the limit last moved."""

    export: ExportFx
    gain: float = 0.0
    offset: float = 0.0
    trim: float = 0.0
    tried: Tries = field(default_factory=list)

    def chain(self) -> str:
        return plan_chain(self.export.plan, self.export.rate, self.offset, self.trim, self.gain)

    def settled(self, out: Loudness, attempt: int) -> bool:
        """Whether ``out`` is final; if not, the settings move for the next pass.
        A region follows only the ceiling: its gain is the whole song's."""
        plan = self.export.plan
        over = overshoot_db(out.tp, plan.ceiling)
        follows = not self.export.region and (self.offset or over)
        miss = missed(plan.target, out) if follows else 0.0
        self.tried.append((self.gain, out.i))
        last = attempt >= MASTER_CEILING_RETRIES
        if self.trim or (not over and (not miss or last)):
            return True
        if last:
            self.trim = over
            return False
        if over:
            self.offset, self.tried = self.offset + over, []
        self.gain += correction_step(miss, self.tried)
        return False


async def _decoded(path: Path, context: str) -> Loudness:
    try:
        return await measure_file(str(path), get_export_sample_rate())
    except MeasureError as exc:
        mastering_logger.warning("%s [%s]: %s", MEASURE_FAILED_DETAIL, context, exc)
        raise HTTPException(status_code=500, detail=MEASURE_FAILED_DETAIL) from None


async def _measured_pass(
    job: VerifyJob,
    chain: str,
    export: ExportFx,
) -> tuple[Path, Loudness]:
    """One render to a temp file, removed if its decoded measurement fails or is cancelled."""
    path = await job.render(with_chain(job.cmd, export.chain, chain), job.suffix, job.context)
    try:
        return path, await _decoded(path, job.context)
    except BaseException:
        path.unlink(missing_ok=True)
        raise


async def render_verified(export: ExportFx, job: VerifyJob) -> tuple[Path, Loudness]:
    """Render a mastered lossy export to temp files, decoded and corrected
    (``_Correction``) until it is settled. Returns the last file, which the
    caller publishes or removes, and its decoded measurement; 499 when the
    client leaves between passes."""
    fix = _Correction(export)
    for attempt in range(MASTER_CEILING_RETRIES + 2):
        path, out = await _measured_pass(job, fix.chain(), export)
        if fix.settled(out, attempt):
            break
        path.unlink(missing_ok=True)
        if await job.gone():
            raise HTTPException(status_code=HTTP_CLIENT_GONE, detail=CLIENT_GONE_DETAIL)
    if overshoot_db(out.tp, export.plan.ceiling):
        mastering_logger.warning(
            "still over the ceiling after %d retries [%s]", attempt, job.context
        )
    return path, out
