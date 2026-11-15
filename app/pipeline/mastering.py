"""Mastering of an export: loudness target, optional glue compressor and a
true-peak limiter on the mix bus, rendered by ffmpeg.

After the lanes are summed and the master EQ has run, the chain is

    [acompressor] -> volume (planned gain) -> 4x aresample -> alimiter -> aresample

and the plan behind it is measured on the whole song:

1. Measure the mix as it reaches the master chain (ffmpeg ``ebur128``:
   BS.1770 gated integrated loudness, 4x true peak, LRA). ffmpeg streams, so
   a long song costs no more memory than a short one. The job's stored
   loudness is never reused: the mix depends on gains, mutes, pitch and EQ.
2. With the compressor on, its threshold sits relative to that loudness (so
   an amount means the same on a quiet and a hot mix), and the mix is
   measured again after it: a gain computed before a compressor lands short.
3. Gain = target - measured, clamped. With no target only the limiter runs.
   ``alimiter`` gets ``level=disabled`` (its default re-normalises to 0 dB)
   and runs at 4x the rate, so its ceiling holds the true peak, not only the
   samples. Lossy formats never get a ceiling above EXPORT_LIMIT_LOSSY_DBTP.
4. The result is measured; when limiting cost more than the tolerance, up to
   MASTER_CORRECTION_PASSES bounded correction passes step the gain along
   the measured loudness-per-dB slope.
5. Resampling down from 4x rebuilds peaks over the ceiling, more the harder
   the limiter is driven: a volume after it trims them, measured once more.
   "Reached" needs the loudness in tolerance and the true peak under the ceiling.

The plan is always made on the whole song, so a region export gets exactly the
gain of the full master; app/pipeline/master_plan_cache.py keeps it on disk.

The caller supplies the graph of the whole song up to the label ``[pre]``
(``plan_graph`` builds one from per-lane chains); this module never builds the
lanes itself. ``parse_master_param`` validates the ``master=`` export
parameter: base64url JSON, size-capped, every field typed and range-checked,
every refusal a ``MasterError`` whose message is safe to show as a 422.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import re
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass
from functools import partial

from app.core.config import (
    EBUR128_FRAMELOG,
    EXPORT_AUDIO_CODEC_AAC,
    EXPORT_FORMAT_OGG,
    EXPORT_LIMIT_LOSSY_DBTP,
    MASTER_COMP_ATTACK_MS,
    MASTER_COMP_KNEE_DB,
    MASTER_COMP_RATIO_PER_AMOUNT,
    MASTER_COMP_RELEASE_MS,
    MASTER_COMP_THRESHOLD_FLOOR_DB,
    MASTER_COMP_THRESHOLD_OFFSET_DB,
    MASTER_COMP_THRESHOLD_PER_AMOUNT_DB,
    MASTER_CORRECTION_MAX_DB,
    MASTER_CORRECTION_PASSES,
    MASTER_CORRECTION_TOL_LU,
    MASTER_GAIN_MAX_DB,
    MASTER_GAIN_MIN_DB,
    MASTER_LIMITER_ATTACK_MS,
    MASTER_LIMITER_MARGIN_DB,
    MASTER_LIMITER_OVERSAMPLE,
    MASTER_LIMITER_RELEASE_MS,
    MASTER_PARAM_MAX_CHARS,
    MASTER_TRIM_MARGIN_DB,
    STEM_FORMAT_MP3,
    TIMEOUT_FFMPEG,
    ffmpeg_executable,
)
from app.pipeline.fx_filters import (
    check_wire_version,
    db_to_linear,
    decode_wire_object,
    linear_to_db,
    read_wire_number,
)

LOGGER_NAME = "stemdeck.mastering"
logger = logging.getLogger(LOGGER_NAME)

MASTER_WIRE_VERSION = 1
TARGET_MIN, TARGET_MAX = -24.0, -6.0
CEILING_MIN, CEILING_MAX = -3.0, -0.1
COMP_MIN, COMP_MAX = 0.0, 1.0
LOSSY_FORMATS = frozenset({STEM_FORMAT_MP3, EXPORT_FORMAT_OGG, EXPORT_AUDIO_CODEC_AAC})

MASTER_PREFIX = "master"
MASTER_TARGET_CEILING_REQUIRED = f"{MASTER_PREFIX}: target and ceiling are required"
MASTER_REQUIRED = f"{MASTER_PREFIX}: required"

# ebur128 reports its -70 LUFS absolute gate for silence.
_SILENCE_LUFS = -69.9
# The compressor's threshold reference when the pre-measurement found silence.
_SILENT_REFERENCE_LUFS = -40.0
# Loudness gained per dB of gain: 1 with no limiting, never assumed below this
# (a limiter at its wall), so a correction step stays bounded.
_LIMITED_SLOPE_MIN = 0.1
_FLOAT_SLACK = 1e-9
_MASTER_KEYS = frozenset({"v", "target", "ceiling", "comp"})
_STDERR_TAIL_LINES = 8
_I_RE = re.compile(r"lavfi\.r128\.I=(\S+)")
_TP_RE = re.compile(r"lavfi\.r128\.true_peak=(\S+)")
_LRA_RE = re.compile(r"lavfi\.r128\.LRA=(\S+)")


class MasterError(ValueError):
    """A malformed or out-of-range ``master`` value. The message is safe to show."""


class MeasureError(RuntimeError):
    """ffmpeg failed or timed out while measuring. The message is for the log only."""


@dataclass(frozen=True)
class MasterSettings:
    """What the user asked for. ``target`` None: only the limiter runs."""

    target: float | None
    ceiling: float
    comp: float = 0.0

    def fragment(self) -> str:
        t = "none" if self.target is None else f"{self.target:.1f}"
        return f"t={t};c={self.ceiling:.1f};k={self.comp:.2f}"


@dataclass(frozen=True)
class Loudness:
    i: float | None  # integrated LUFS, None for silence
    tp: float | None  # true peak dBTP, None for digital silence
    lra: float | None = None


@dataclass(frozen=True)
class MasterPlan:
    """The measured master of one mix: what the render applies and reports."""

    target: float | None
    ceiling: float
    comp: float
    pre: Loudness
    comp_threshold_db: float | None
    comp_i: float | None
    gain_db: float
    post: Loudness
    reached: bool
    trim_db: float = 0.0

    def to_json(self) -> dict:
        """The loudness route's JSON; ``comp_ratio`` is null when the compressor is off."""
        return {
            "target": self.target,
            "ceiling": self.ceiling,
            "comp": self.comp,
            "comp_ratio": None if self.comp_threshold_db is None else comp_ratio(self.comp),
            "pre": asdict(self.pre),
            "comp_threshold_db": self.comp_threshold_db,
            "comp_i": self.comp_i,
            "gain_db": self.gain_db,
            "post": asdict(self.post),
            "reached": self.reached,
            "trim_db": self.trim_db,
        }

    @classmethod
    def from_json(cls, data: dict) -> MasterPlan:
        fields = {k: v for k, v in data.items() if k != "comp_ratio"}
        pre, post = Loudness(**data["pre"]), Loudness(**data["post"])
        return cls(**{**fields, "pre": pre, "post": post})


Measurer = Callable[[list[str], str, str, int], Awaitable[Loudness]]


_number = partial(read_wire_number, error=MasterError, prefix=MASTER_PREFIX)


def _decode(raw: str) -> dict:
    body = decode_wire_object(raw, MASTER_PARAM_MAX_CHARS, _MASTER_KEYS, MasterError, MASTER_PREFIX)
    check_wire_version(body, MASTER_WIRE_VERSION, MasterError, MASTER_PREFIX)
    if "target" not in body or "ceiling" not in body:
        raise MasterError(MASTER_TARGET_CEILING_REQUIRED)
    return body


def parse_master_param(raw: str | None) -> MasterSettings | None:
    """Decode ``{"v": 1, "target": LUFS | null, "ceiling": dBTP, "comp": 0..1}``.
    Empty means mastering off (None). Raises MasterError."""
    if not raw:
        return None
    body = _decode(raw)
    target = body["target"]
    if target is not None:
        target = round(_number(target, TARGET_MIN, TARGET_MAX, "target"), 1)
    ceiling = round(_number(body["ceiling"], CEILING_MIN, CEILING_MAX, "ceiling"), 1)
    comp = round(_number(body.get("comp", 0), COMP_MIN, COMP_MAX, "comp"), 2)
    return MasterSettings(target=target, ceiling=ceiling, comp=comp)


def require_master_param(raw: str | None) -> MasterSettings:
    """``parse_master_param`` for a route that cannot run without a master."""
    settings = parse_master_param(raw)
    if settings is None:
        raise MasterError(MASTER_REQUIRED)
    return settings


def encode_master_param(settings: MasterSettings) -> str:
    """The wire form the browser builds (tests and scripts)."""
    body = {"v": MASTER_WIRE_VERSION, "target": settings.target, "ceiling": settings.ceiling}
    if settings.comp:
        body["comp"] = settings.comp
    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def effective_ceiling(settings: MasterSettings, output_format: str) -> float:
    """The ceiling the render uses: capped for a lossy encoder (mp3, ogg, aac)."""
    if output_format in LOSSY_FORMATS:
        return min(settings.ceiling, EXPORT_LIMIT_LOSSY_DBTP)
    return settings.ceiling


def _lin(db: float) -> str:
    return f"{db_to_linear(db):.8f}"


def comp_threshold_db(comp: float, target: float | None, pre_i: float | None) -> float | None:
    """The compressor threshold for a measured loudness, None when off. With no
    target only the limiter runs, whatever the amount."""
    if comp <= 0 or target is None:
        return None
    base = pre_i if pre_i is not None else _SILENT_REFERENCE_LUFS
    raw = base + MASTER_COMP_THRESHOLD_OFFSET_DB - MASTER_COMP_THRESHOLD_PER_AMOUNT_DB * comp
    return round(min(0.0, max(MASTER_COMP_THRESHOLD_FLOOR_DB, raw)), 2)


def comp_ratio(comp: float) -> float:
    return round(1.0 + MASTER_COMP_RATIO_PER_AMOUNT * comp, 3)


def comp_filter(comp: float, threshold_db: float | None) -> str:
    """``acompressor`` for the glue compressor, "" when off."""
    if comp <= 0 or threshold_db is None:
        return ""
    knee = db_to_linear(MASTER_COMP_KNEE_DB)
    return (
        f"acompressor=threshold={_lin(threshold_db)}:ratio={comp_ratio(comp)}"
        f":attack={MASTER_COMP_ATTACK_MS}:release={MASTER_COMP_RELEASE_MS}:knee={knee:.6f}"
        ":detection=rms:link=average:makeup=1"
    )


def limiter_filter(ceiling_db: float, rate: int) -> str:
    """True-peak limiter: alimiter at the oversampled rate, then back to ``rate``."""
    limit = _lin(ceiling_db - MASTER_LIMITER_MARGIN_DB)
    return (
        f"aresample={MASTER_LIMITER_OVERSAMPLE * rate},"
        f"alimiter=limit={limit}:attack={MASTER_LIMITER_ATTACK_MS}"
        f":release={MASTER_LIMITER_RELEASE_MS}:level=disabled:latency=1,"
        f"aresample={rate}"
    )


def trim_filter(trim_db: float) -> str:
    """A level trim after the limiter, "" for none."""
    return f"volume={_lin(-trim_db)}" if trim_db > 0 else ""


def ceiling_trim(tp: float | None, ceiling_db: float) -> float:
    """How far to turn a true peak down to sit a margin under the ceiling, 0 when it does."""
    if tp is None or tp <= ceiling_db:
        return 0.0
    return round(tp - ceiling_db + MASTER_TRIM_MARGIN_DB, 3)


def master_chain(
    comp: float,
    threshold_db: float | None,
    gain_db: float,
    ceiling_db: float,
    rate: int,
    trim_db: float = 0.0,
) -> str:
    """The whole master chain after the master EQ, without a trailing comma."""
    parts = [comp_filter(comp, threshold_db)]
    if gain_db != 0:
        parts.append(f"volume={_lin(gain_db)}")
    parts.append(limiter_filter(ceiling_db, rate))
    parts.append(trim_filter(trim_db))
    return ",".join(p for p in parts if p)


def plan_chain(plan: MasterPlan, rate: int) -> str:
    return master_chain(
        plan.comp,
        plan.comp_threshold_db,
        plan.gain_db,
        plan.ceiling,
        rate,
        plan.trim_db,
    )


def plan_graph(lane_chains: list[str], master_eq: str) -> str:
    """Input i through ``lane_chains[i]``, summed, then the master EQ (""
    or a prefix ending in a comma), labelled [pre]. No click: the loudness is
    set for the music, not the practice aid."""
    filters = [f"[{i}:a]{chain}[a{i}]" for i, chain in enumerate(lane_chains)]
    n = len(lane_chains)
    if n > 1:
        labels = "".join(f"[a{i}]" for i in range(n))
        filters.append(f"{labels}amix=inputs={n}:normalize=0,{master_eq}anull[pre]")
    else:
        filters.append(f"[a0]{master_eq}anull[pre]")
    return ";".join(filters)


def meter_filter(rate: int) -> str:
    """One-second frames (a line a second, not ten), ebur128's cumulative
    values as printed metadata; the last values cover the whole signal."""
    return (
        f"asetnsamples=n={rate}:p=0,"
        f"ebur128=peak=true:metadata=1:framelog={EBUR128_FRAMELOG},"
        "ametadata=mode=print:key=lavfi.r128.I,"
        "ametadata=mode=print:key=lavfi.r128.LRA,"
        "ametadata=mode=print:key=lavfi.r128.true_peak"
    )


def _last_float(regex: re.Pattern[str], text: str) -> float | None:
    found = regex.findall(text)
    try:
        value = float(found[-1]) if found else None
    except ValueError:
        return None
    return value if value is not None and math.isfinite(value) else None


def _rounded(v: float | None) -> float | None:
    return None if v is None else round(v, 3)


def parse_meter(text: str) -> Loudness:
    """Loudness from ``meter_filter``'s printed metadata."""
    i = _last_float(_I_RE, text)
    if i is not None and i <= _SILENCE_LUFS:
        i = None
    tp_lin = _last_float(_TP_RE, text)
    tp = linear_to_db(tp_lin) if tp_lin and tp_lin > 0 else None
    return Loudness(_rounded(i), _rounded(tp), _rounded(_last_float(_LRA_RE, text)))


def clamp_gain(gain_db: float) -> float:
    return round(min(MASTER_GAIN_MAX_DB, max(MASTER_GAIN_MIN_DB, gain_db)), 4)


def _measure_cmd(inputs: list[str], graph: str, chain: str, rate: int) -> list[str]:
    tail = f"{chain}," if chain else ""
    return [
        *(ffmpeg_executable(), "-nostdin", "-hide_banner", "-nostats", "-loglevel", "info"),
        *inputs,
        *("-filter_complex", f"{graph};[pre]{tail}{meter_filter(rate)}[out]"),
        *("-map", "[out]", "-f", "null", "-"),
    ]


async def measure_chain(inputs: list[str], graph: str, chain: str, rate: int) -> Loudness:
    """Run ``graph`` (ending in [pre]) through ``chain`` and the meter to a
    null output. ``inputs`` are ffmpeg's -i arguments. Raises MeasureError."""
    proc = await asyncio.create_subprocess_exec(
        *_measure_cmd(inputs, graph, chain, rate),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _out, err = await asyncio.wait_for(proc.communicate(), timeout=TIMEOUT_FFMPEG)
    except (TimeoutError, asyncio.TimeoutError):
        raise MeasureError("loudness measurement timed out") from None
    finally:
        # Also reached when the request is cancelled (the client went away).
        if proc.returncode is None:
            proc.kill()
            await proc.wait()
    text = (err or b"").decode("utf-8", "replace")
    if proc.returncode != 0:
        tail_lines = deque(text.splitlines(), maxlen=_STDERR_TAIL_LINES)
        raise MeasureError(f"ffmpeg exit {proc.returncode}: {' | '.join(tail_lines)}")
    return parse_meter(text)


def _correction_step(miss: float, tried: list[tuple[float, float | None]]) -> float:
    slope = 1.0
    if len(tried) > 1:
        (g0, l0), (g1, l1) = tried[-2], tried[-1]
        if g1 != g0 and l0 is not None and l1 is not None:
            slope = min(1.0, max(_LIMITED_SLOPE_MIN, (l1 - l0) / (g1 - g0)))
    return max(-MASTER_CORRECTION_MAX_DB, min(MASTER_CORRECTION_MAX_DB, miss / slope))


def _missed(target: float, post: Loudness) -> float | None:
    """How far the result is from the target, None when it is close enough."""
    if post.i is None or abs(target - post.i) <= MASTER_CORRECTION_TOL_LU:
        return None
    return target - post.i


async def _settle_gain(
    gain: float,
    post: Loudness,
    target: float,
    run: Callable[[float], Awaitable[Loudness]],
) -> tuple[float, Loudness]:
    """Up to MASTER_CORRECTION_PASSES bounded steps toward the target."""
    tried = [(gain, post.i)]
    for _ in range(MASTER_CORRECTION_PASSES):
        miss = _missed(target, post)
        if miss is None:
            break
        fixed = clamp_gain(gain + _correction_step(miss, tried))
        if fixed == gain:
            break
        gain, post = fixed, await run(fixed)
        tried.append((gain, post.i))
    return gain, post


def target_reached(target: float | None, ceiling_db: float, post: Loudness) -> bool:
    """Loudness within tolerance of the target (any, with none) and the true peak under the ceiling."""
    if ceiling_trim(post.tp, ceiling_db):
        return False
    if target is None:
        return True
    return post.i is not None and abs(target - post.i) <= MASTER_CORRECTION_TOL_LU + _FLOAT_SLACK


async def _comp_loudness(
    inputs: list[str],
    graph: str,
    comp: float,
    threshold: float | None,
    rate: int,
    measure: Measurer,
) -> float | None:
    """The loudness after the glue compressor, None when it is off."""
    if threshold is None:
        return None
    return (await measure(inputs, graph, comp_filter(comp, threshold), rate)).i


async def run_plan(
    inputs: list[str],
    graph: str,
    settings: MasterSettings,
    ceiling_db: float,
    rate: int,
    measure: Measurer = measure_chain,
) -> MasterPlan:
    """Measure the mix and decide the gain and trim. ``graph`` ends in the label [pre]."""
    pre = await measure(inputs, graph, "", rate)
    threshold = comp_threshold_db(settings.comp, settings.target, pre.i)
    comp_i = await _comp_loudness(inputs, graph, settings.comp, threshold, rate, measure)
    level = pre.i if threshold is None else comp_i

    async def run(gain: float, trim: float = 0.0) -> Loudness:
        chain = master_chain(settings.comp, threshold, gain, ceiling_db, rate, trim)
        return await measure(inputs, graph, chain, rate)

    no_gain = settings.target is None or level is None
    gain = 0.0 if no_gain else clamp_gain(settings.target - level)
    post = await run(gain)
    if not no_gain:
        gain, post = await _settle_gain(gain, post, settings.target, run)
    trim = ceiling_trim(post.tp, ceiling_db)
    if trim:
        post = await run(gain, trim)
    return MasterPlan(
        target=settings.target,
        ceiling=ceiling_db,
        comp=settings.comp,
        pre=pre,
        comp_threshold_db=threshold,
        comp_i=comp_i,
        gain_db=gain,
        post=post,
        reached=target_reached(settings.target, ceiling_db, post),
        trim_db=trim,
    )
