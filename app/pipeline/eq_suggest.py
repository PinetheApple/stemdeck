"""A Suggest EQ answer, assembled from a measured spectrum, a target and the
lane's current EQ. Pure: the API (app/api/suggest.py) measures, this decides
and explains. Everything returned is numbers and i18n keys; the browser turns
them into text and into an ordinary EQ descriptor. The server never writes
the mix.

Modes:
- "replace": the suggestion is fitted to the lane as it sounds with no EQ,
  and replaces its EQ.
- "merge" (graphical panels only): fitted to the lane as it sounds now,
  through its current EQ; the new bands follow the current ones (up to the
  engine's band limit) and the output gain is adjusted by what they change.

Loudness-neutral: ``out`` cancels the estimated K-weighted loudness change of
the new bands on the measured, gated spectrum, so Preview compares like with
like; ``loudness`` is what is left of it (against the lane with no EQ in
replace mode, against the lane through its current EQ in merge mode).

A lane with too little to measure (under SUGGEST_MIN_GATED_SECONDS of loud
audio, or quieter than SUGGEST_MIN_LANE_LUFS) is refused with
``NotEnoughSignal`` rather than guessed at.

``recommend_master`` picks a master loudness preset from the mix's measured
integrated loudness and true peak: never louder than the material allows,
i.e. never asking the limiter for more than SUGGEST_LIMIT_ALLOWANCE_DB on
the loudest peaks.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from app.core.config import (
    FX_MAX_BANDS,
    SUGGEST_CEILING_DBTP,
    SUGGEST_CUSTOM_MIN_LUFS,
    SUGGEST_DEFAULT_TARGET_LUFS,
    SUGGEST_DENSE_LUFS,
    SUGGEST_DENSE_PLR_DB,
    SUGGEST_LIMIT_ALLOWANCE_DB,
    SUGGEST_LOUDER_COMP,
    SUGGEST_LOUDER_LUFS,
    SUGGEST_MIN_GATED_SECONDS,
    SUGGEST_MIN_LANE_LUFS,
)
from app.pipeline.eq_analysis import (
    CENTRES_HZ,
    N_BANDS,
    Spectrum,
    apply_eq,
    bands_db,
    loudness_change_db,
    loudness_of_power,
)
from app.pipeline.eq_fit import FitResult, fit_eq, neutral_out_db, weighted_rms_db, weights_for
from app.pipeline.eq_targets import Target
from app.pipeline.fx_filters import HIGHSHELF, LOWCUT, LOWSHELF, TILT, Band, Eq

REPLACE = "replace"
MERGE = "merge"
MODES = (REPLACE, MERGE)
NOT_ENOUGH_SIGNAL = "not enough signal"
_DECIMALS = 2
_REASON_DECIMALS = 1
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

PRESET_GENTLE = "gentle"
PRESET_STREAMING = "streaming"
PRESET_LOUDER = "louder"
PRESET_CUSTOM = "custom"
# Custom targets are offered on a half-dB grid.
_CUSTOM_STEPS_PER_DB = 2.0


class NotEnoughSignal(ValueError):
    """Too little loud audio to measure. The message is safe to show."""


def is_quiet(spec: Spectrum) -> bool:
    return (
        spec.silent
        or spec.gated_seconds < SUGGEST_MIN_GATED_SECONDS
        or loudness_of_power(spec.power) < SUGGEST_MIN_LANE_LUFS
    )


def _band_json(band: Band, slot: str | None) -> dict:
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
    return {"key": "suggest.why.distance", "vars": {"before": before, "after": after}}


def _reasons(spec: Spectrum, target: Target, done: _Fitted) -> list[dict]:
    reasons = band_reasons(done.fit)
    if done.new:
        change = round(loudness_change_db(done.base, done.new), _REASON_DECIMALS)
        out = round(done.out - done.ref_out, _REASON_DECIMALS)
        reasons.append({"key": "suggest.why.out", "vars": {"d": change, "out": out}})
    else:
        reasons.append({"key": "suggest.why.close", "vars": {}})
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
    """The answer for one lane or the mix, in the contract's shape. Raises
    NotEnoughSignal when there is too little to measure."""
    if is_quiet(spec):
        raise NotEnoughSignal(NOT_ENOUGH_SIGNAL)
    done = _fitted(spec, target, layout, mode, current, max_bands)
    residual = loudness_change_db(done.base, done.new, done.out - done.ref_out)
    kept = [_band_json(b, None) for b in done.kept]
    return {
        "bands": kept + [_band_json(fb.band, fb.slot) for fb in done.fit.bands],
        "out": done.out,
        "reasons": _reasons(spec, target, done),
        "loudness": round(residual, _DECIMALS),
        "target": target.id,
        "targets": targets,
    }


def region_of(f: float) -> str:
    return next((name for edge, name in _REGIONS if f < edge), _TOP_REGION)


def _mean_dev(dev: np.ndarray, w: np.ndarray, mask: np.ndarray) -> float:
    ww = w * mask
    if ww.sum() <= 0:
        return float(dev[mask].mean()) if mask.any() else 0.0
    return float(ww @ dev) / float(ww.sum())


def _band_mask_and_key(band: Band) -> tuple[np.ndarray, str]:
    """The third-octave bands a band acts on, and its reason's i18n key."""
    fc, cut = np.asarray(CENTRES_HZ), band.g < 0
    if band.type == LOWSHELF:
        return fc <= band.f * _SHELF_REACH, f"suggest.why.lowShelf{'Cut' if cut else 'Boost'}"
    if band.type == HIGHSHELF:
        return fc >= band.f / _SHELF_REACH, f"suggest.why.highShelf{'Cut' if cut else 'Boost'}"
    if band.type == TILT:
        return fc >= band.f, f"suggest.why.tilt{'Darker' if cut else 'Brighter'}"
    i = int(np.argmin(np.abs(np.log2(fc / band.f))))
    mask = np.zeros(N_BANDS, dtype=bool)
    mask[max(0, i - 1) : i + 2] = True
    return mask, f"suggest.why.bell{'Cut' if cut else 'Boost'}"


def _band_reason(band: Band, dev: np.ndarray, w: np.ndarray) -> dict:
    if band.type == LOWCUT:
        d = _mean_dev(dev, w, np.asarray(CENTRES_HZ) < band.f)
        return {"key": "suggest.why.lowCut", "vars": {"f": band.f, "dev": round(d, 1)}}
    mask, key = _band_mask_and_key(band)
    d = round(_mean_dev(dev, w, mask), _REASON_DECIMALS)
    return {"key": key, "vars": {"f": band.f, "g": band.g, "dev": d, "region": region_of(band.f)}}


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
    limit_db: float  # what the limiter is estimated to take off the loudest peaks
    reason: dict
    ceiling_dbtp: float = SUGGEST_CEILING_DBTP

    def to_json(self) -> dict:
        return {
            "preset": self.preset,
            "target_lufs": self.target_lufs,
            "ceiling_dbtp": self.ceiling_dbtp,
            "comp": self.comp,
        }


def _limiting(target: float, plr: float) -> float:
    return round(max(0.0, target - SUGGEST_CEILING_DBTP + plr), _REASON_DECIMALS)


def _louder_or_streaming(
    i: float,
    plr: float,
    want: float,
    allowed: float,
) -> MasterSuggestion | None:
    nums = {"i": round(i, 1), "plr": round(plr, 1)}
    if plr < SUGGEST_DENSE_PLR_DB and i > SUGGEST_DENSE_LUFS and allowed >= SUGGEST_LOUDER_LUFS:
        why = {"key": "suggest.why.master.louder", "vars": {**nums, "target": SUGGEST_LOUDER_LUFS}}
        limit = _limiting(SUGGEST_LOUDER_LUFS, plr)
        return MasterSuggestion(PRESET_LOUDER, SUGGEST_LOUDER_LUFS, SUGGEST_LOUDER_COMP, limit, why)
    if allowed >= want:
        limit = _limiting(want, plr)
        why = {
            "key": "suggest.why.master.streaming",
            "vars": {**nums, "target": want, "limit": limit},
        }
        return MasterSuggestion(PRESET_STREAMING, want, 0.0, limit, why)
    return None


def _quieter(i: float, tp: float, want: float, allowed: float) -> MasterSuggestion:
    plr, nums = tp - i, {"i": round(i, 1), "plr": round(tp - i, 1)}
    if allowed < SUGGEST_CUSTOM_MIN_LUFS:
        # Even the quietest target would squash the peaks: only the limiter, against clipping.
        limit = round(max(0.0, tp - SUGGEST_CEILING_DBTP), _REASON_DECIMALS)
        why = {"key": "suggest.why.master.gentle", "vars": nums}
        return MasterSuggestion(PRESET_GENTLE, None, 0.0, limit, why)
    target = math.floor(allowed * _CUSTOM_STEPS_PER_DB) / _CUSTOM_STEPS_PER_DB
    limit = _limiting(target, plr)
    vars_ = {**nums, "target": target, "want": want, "limit": limit}
    why = {"key": "suggest.why.master.dynamic", "vars": vars_}
    return MasterSuggestion(PRESET_CUSTOM, target, 0.0, limit, why)


def recommend_master(
    i: float | None,
    tp: float | None,
    target_lufs: float | None,
) -> MasterSuggestion:
    """A master preset from the mix's integrated loudness ``i`` and true peak
    ``tp``: the loudest target whose peaks the limiter trims by at most the
    allowance, dense loud material kept loud, silence left alone."""
    if i is None or tp is None:
        why = {"key": "suggest.why.master.silent", "vars": {}}
        return MasterSuggestion(PRESET_GENTLE, None, 0.0, 0.0, why)
    want = SUGGEST_DEFAULT_TARGET_LUFS if target_lufs is None else float(target_lufs)
    allowed = SUGGEST_CEILING_DBTP - (tp - i) + SUGGEST_LIMIT_ALLOWANCE_DB
    return _louder_or_streaming(i, tp - i, want, allowed) or _quieter(i, tp, want, allowed)
