"""A Suggest EQ answer, assembled from a measured spectrum, a target and the
lane's current EQ. Pure: the API (app/api/suggest.py) measures, this decides
and explains. Everything returned is numbers and i18n keys; the browser turns
them into text and into an ordinary EQ descriptor. The server never writes
the mix.

Modes:
- "replace": the suggestion is fitted to the lane as it sounds with no EQ,
  and replaces its EQ.
- "merge": fitted to the lane as it sounds now,
  through its current EQ. Only the new bands come back, at most the band
  limit minus the bands already in ``fx``; the client appends them (the
  current EQ may hold bands that are off, which ``fx`` leaves out) and sets
  ``out``, the output gain for the whole EQ.

Loudness-neutral: ``out`` cancels the estimated K-weighted loudness change of
the new bands on the measured, gated spectrum, so Preview compares like with
like; ``loudness`` is what is left of it (against the lane with no EQ in
replace mode, against the lane through its current EQ in merge mode).

``target_curve`` is the per-band correction the target asks for, as the fit
sees it ([nominal Hz, dB] for the 31 bands, 0 where content is missing): the
panel draws it as the dashed Target line.

A lane with too little to measure (under SUGGEST_MIN_GATED_SECONDS of loud
audio, or quieter than SUGGEST_MIN_LANE_LUFS) is refused with
``NotEnoughSignal`` rather than guessed at.

``recommend_master`` picks a master loudness preset from the mix's measured
integrated loudness and true peak: never louder than the material allows,
i.e. never asking the limiter for more than SUGGEST_LIMIT_ALLOWANCE_DB on
the loudest peaks. The streaming target is the mix target's own loudness.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.core.config import (
    FX_MAX_BANDS,
    MASTER_PRESET_CEILING_DBTP,
    MASTER_PRESET_LOUDER_COMP,
    MASTER_PRESET_LOUDER_LUFS,
    SUGGEST_DENSE_LUFS,
    SUGGEST_DENSE_PLR_DB,
    SUGGEST_LIMIT_ALLOWANCE_DB,
    SUGGEST_MIN_GATED_SECONDS,
    SUGGEST_MIN_LANE_LUFS,
    SUGGEST_OUT_MAX_DB,
)
from app.pipeline.eq_analysis import (
    CENTRES_HZ,
    N_BANDS,
    NOMINAL_HZ,
    Spectrum,
    apply_eq,
    bands_db,
    loudness_change_db,
    loudness_of_power,
)
from app.pipeline.eq_fit import (
    FitResult,
    fit_eq,
    nearest_band,
    target_gap,
    weighted_rms_db,
    weights_for,
)
from app.pipeline.eq_targets import Target
from app.pipeline.fx_filters import BELL, HIGHSHELF, LOWCUT, LOWSHELF, OUT_MAX, OUT_MIN, Band, Eq
from app.pipeline.mastering import TARGET_MIN

REPLACE = "replace"
MERGE = "merge"
MODES = (REPLACE, MERGE)
NOT_ENOUGH_SIGNAL = "not enough signal"
_DECIMALS = 2
_REASON_DECIMALS = 1
_OUT_DECIMALS = 1
# A shelf's reason looks at the bands up to this factor past its corner.
_SHELF_REACH = 1.5

# Upper edges (Hz) of the regions a reason names, lowest first; the rest is "air".
_REGIONS = (
    (60, "sub"),
    (250, "bass"),
    (600, "lowmid"),
    (2000, "mid"),
    (5000, "uppermid"),
    (10000, "high"),
)
_TOP_REGION = "air"

WHY_OUT = "suggest.why.out"
WHY_CLOSE = "suggest.why.close"
WHY_DISTANCE = "suggest.why.distance"
WHY_LOW_CUT = "suggest.why.lowCut"
# Per band type: the reason's key for a cut, then for a boost.
WHY_BY_TYPE = {
    BELL: ("suggest.why.bellCut", "suggest.why.bellBoost"),
    LOWSHELF: ("suggest.why.lowShelfCut", "suggest.why.lowShelfBoost"),
    HIGHSHELF: ("suggest.why.highShelfCut", "suggest.why.highShelfBoost"),
}

PRESET_GENTLE = "gentle"
PRESET_STREAMING = "streaming"
PRESET_LOUDER = "louder"
PRESET_CUSTOM = "custom"
WHY_MASTER_GENTLE = "suggest.why.master.gentle"
WHY_MASTER_STREAMING = "suggest.why.master.streaming"
WHY_MASTER_LOUDER = "suggest.why.master.louder"
WHY_MASTER_DYNAMIC = "suggest.why.master.dynamic"
# Custom targets are offered on a half-dB grid.
_CUSTOM_STEPS_PER_DB = 2.0
_NO_COMP = 0.0


class NotEnoughSignal(ValueError):
    """Too little loud audio to measure. The message is safe to show."""


def _why(key: str, **values: object) -> dict:
    """A reason: an i18n key and the numbers its text needs."""
    return {"key": key, "vars": values}


def is_quiet(spec: Spectrum) -> bool:
    return (
        spec.silent
        or spec.gated_seconds < SUGGEST_MIN_GATED_SECONDS
        or loudness_of_power(spec.power) < SUGGEST_MIN_LANE_LUFS
    )


def neutral_out_db(power: np.ndarray, bands: list[Band], base_out: float = 0.0) -> float:
    """The output gain that keeps ``power``'s K-weighted loudness where it was
    with ``base_out`` after ``bands``: the change capped at SUGGEST_OUT_MAX_DB,
    the total inside the EQ's own range."""
    change = -loudness_change_db(power, bands, 0.0)
    change = max(-SUGGEST_OUT_MAX_DB, min(SUGGEST_OUT_MAX_DB, change))
    return round(max(OUT_MIN, min(OUT_MAX, base_out + change)), _OUT_DECIMALS)


def _target_curve(fit: FitResult) -> list[list[float]]:
    gaps = target_gap(fit)
    return [[f, round(float(g), _DECIMALS)] for f, g in zip(NOMINAL_HZ, gaps, strict=True)]


def _band_json(band: Band, slot: str) -> dict:
    return {
        "type": band.type,
        "f": band.f,
        "g": band.g,
        "q": band.q,
        "slope": band.slope,
        "slot": slot,
    }


@dataclass(frozen=True)
class _Fitted:
    """One fit's outcome: the spectrum it was fitted on and what it adds."""

    fit: FitResult
    base: np.ndarray  # the power the fit saw (through the current EQ in merge mode)
    kept: list[Band]  # current bands that stay (merge mode)
    new: list[Band]
    ref_out: float  # the output gain the answer is loudness-neutral against
    out: float


def _fitted(
    spec: Spectrum,
    target: Target,
    layout: str,
    mode: str,
    current: Eq | None,
    max_bands: int,
) -> _Fitted:
    cur_bands = list(current.bands) if current else []
    cur_out = current.out if current else 0.0
    merge = mode == MERGE
    base = apply_eq(spec.power, cur_bands, cur_out) if merge else spec.power
    room = FX_MAX_BANDS - len(cur_bands) if merge else max_bands
    fit = fit_eq(
        bands_db(base),
        target.bands_db,
        layout,
        max(0, min(max_bands, room)),
        boost_ref=spec.bands,
    )
    new = [fb.band for fb in fit.bands]
    ref_out = cur_out if merge else 0.0
    kept = cur_bands if merge else []
    return _Fitted(fit, base, kept, new, ref_out, neutral_out_db(base, new, ref_out))


def _distance_reason(spec: Spectrum, target: Target, before_db, done: _Fitted) -> dict:
    raw_db = spec.bands
    w = weights_for(raw_db)
    tgt = np.asarray(target.bands_db, dtype=np.float64)
    after_db = bands_db(apply_eq(spec.power, done.kept + done.new, done.out))
    before = round(weighted_rms_db(tgt - before_db, w), _DECIMALS)
    after = round(weighted_rms_db(tgt - after_db, w), _DECIMALS)
    return _why(WHY_DISTANCE, before=before, after=after)


def _reasons(spec: Spectrum, target: Target, done: _Fitted) -> list[dict]:
    reasons = band_reasons(done.fit)
    if done.new:
        change = round(loudness_change_db(done.base, done.new), _REASON_DECIMALS)
        out = round(done.out - done.ref_out, _REASON_DECIMALS)
        reasons.append(_why(WHY_OUT, d=change, out=out))
    else:
        reasons.append(_why(WHY_CLOSE))
    reasons.append(_distance_reason(spec, target, bands_db(done.base), done))
    return reasons


def make_suggestion(
    spec: Spectrum,
    target: Target,
    layout: str,
    mode: str,
    current: Eq | None,
    max_bands: int,
    targets: list[dict],
) -> dict:
    """The answer for one lane, in the contract's shape: in merge mode the
    new bands only. Raises NotEnoughSignal when there is too little to measure."""
    if is_quiet(spec):
        raise NotEnoughSignal(NOT_ENOUGH_SIGNAL)
    done = _fitted(spec, target, layout, mode, current, max_bands)
    residual = loudness_change_db(done.base, done.new, done.out - done.ref_out)
    return {
        "bands": [_band_json(fb.band, fb.slot) for fb in done.fit.bands],
        "out": done.out,
        "reasons": _reasons(spec, target, done),
        "loudness": round(residual, _DECIMALS),
        "target": target.id,
        "targets": targets,
        "target_curve": _target_curve(done.fit),
    }


def region_of(f: float) -> str:
    return next((name for edge, name in _REGIONS if f < edge), _TOP_REGION)


def _mean_dev(dev: np.ndarray, w: np.ndarray, mask: np.ndarray) -> float:
    ww = w * mask
    if ww.sum() <= 0:
        return float(dev[mask].mean()) if mask.any() else 0.0
    return float(ww @ dev) / float(ww.sum())


def _band_mask(band: Band) -> np.ndarray:
    """The third-octave bands a band acts on."""
    fc = np.asarray(CENTRES_HZ)
    if band.type == LOWSHELF:
        return fc <= band.f * _SHELF_REACH
    if band.type == HIGHSHELF:
        return fc >= band.f / _SHELF_REACH
    i = nearest_band(band.f)
    mask = np.zeros(N_BANDS, dtype=bool)
    mask[max(0, i - 1) : i + 2] = True
    return mask


def _band_reason(band: Band, dev: np.ndarray, w: np.ndarray) -> dict:
    if band.type == LOWCUT:
        d = round(_mean_dev(dev, w, np.asarray(CENTRES_HZ) < band.f), _REASON_DECIMALS)
        return _why(WHY_LOW_CUT, f=band.f, dev=d)
    key = WHY_BY_TYPE[band.type][band.g >= 0]
    d = round(_mean_dev(dev, w, _band_mask(band)), _REASON_DECIMALS)
    return _why(key, f=band.f, g=band.g, dev=d, region=region_of(band.f))


def band_reasons(fit: FitResult) -> list[dict]:
    """One reason per band, from the numbers: how far the measured spectrum
    is from the target where the band acts (``dev``: measured minus target,
    positive means too much there), and what the band does."""
    return [_band_reason(fb.band, -fit.error_db, fit.weights) for fb in fit.bands]


@dataclass(frozen=True)
class MasterSuggestion:
    preset: str
    target_lufs: float | None
    comp: float
    reason: dict
    ceiling_dbtp: float = MASTER_PRESET_CEILING_DBTP

    def to_json(self) -> dict:
        return {
            "preset": self.preset,
            "target_lufs": self.target_lufs,
            "ceiling_dbtp": self.ceiling_dbtp,
            "comp": self.comp,
        }


@dataclass(frozen=True)
class _Material:
    """The mix's integrated loudness, true peak and peak-to-loudness ratio."""

    i: float
    tp: float

    @property
    def plr(self) -> float:
        return self.tp - self.i

    def why(self, key: str, **extra: float) -> dict:
        """A master reason with the mix's numbers and ``extra``."""
        nums = {"i": self.i, "tp": self.tp, "plr": self.plr}
        rounded = {k: round(v, _REASON_DECIMALS) for k, v in nums.items()}
        return _why(key, **rounded, **extra)


def _limiting(target: float, plr: float) -> float:
    """What the limiter is estimated to take off the loudest peaks at ``target``."""
    return round(max(0.0, target - MASTER_PRESET_CEILING_DBTP + plr), _REASON_DECIMALS)


def _louder_or_streaming(m: _Material, want: float, allowed: float) -> MasterSuggestion | None:
    # Dense material always has room for the louder preset under the allowance.
    if m.plr < SUGGEST_DENSE_PLR_DB and m.i > SUGGEST_DENSE_LUFS:
        louder = MASTER_PRESET_LOUDER_LUFS
        why = m.why(WHY_MASTER_LOUDER, target=louder)
        return MasterSuggestion(PRESET_LOUDER, louder, MASTER_PRESET_LOUDER_COMP, why)
    if allowed >= want:
        why = m.why(WHY_MASTER_STREAMING, target=want, limit=_limiting(want, m.plr))
        return MasterSuggestion(PRESET_STREAMING, want, _NO_COMP, why)
    return None


def _quieter(m: _Material, want: float, allowed: float) -> MasterSuggestion:
    if allowed < TARGET_MIN:
        # Even the quietest target would squash the peaks: only the limiter, against clipping.
        return MasterSuggestion(PRESET_GENTLE, None, _NO_COMP, m.why(WHY_MASTER_GENTLE))
    target = math.floor(allowed * _CUSTOM_STEPS_PER_DB) / _CUSTOM_STEPS_PER_DB
    limit = _limiting(target, m.plr)
    why = m.why(WHY_MASTER_DYNAMIC, target=target, want=want, limit=limit)
    return MasterSuggestion(PRESET_CUSTOM, target, _NO_COMP, why)


def recommend_master(i: float, tp: float, want: float) -> MasterSuggestion:
    """A master preset from the mix's integrated loudness ``i`` and true peak
    ``tp``: the loudest target up to ``want`` whose peaks the limiter trims by
    at most the allowance, dense loud material kept loud."""
    m, want_lufs = _Material(i, tp), float(want)
    allowed = MASTER_PRESET_CEILING_DBTP - m.plr + SUGGEST_LIMIT_ALLOWANCE_DB
    return _louder_or_streaming(m, want_lufs, allowed) or _quieter(m, want_lufs, allowed)
