"""A Suggest EQ answer, assembled from a measured spectrum, a target and the
lane's current EQ. Pure: the API (app/api/suggest.py) measures, this decides
and explains. Everything returned is numbers and i18n keys; the browser turns
them into text and into an ordinary EQ descriptor. The server never writes
the mix.

Modes:
- "replace": the suggestion is fitted to the lane as it sounds with no EQ,
  and replaces its EQ.
- "merge" (graphical panels only): fitted to the lane as it sounds now,
  through its current EQ. Only the new bands come back, at most the band
  limit minus the bands already in ``fx``; the client appends them (the
  current EQ may hold bands that are off, which ``fx`` leaves out) and sets
  ``out``, the output gain for the whole EQ.

Loudness-neutral: ``out`` cancels the estimated K-weighted loudness change of
the new bands on the measured, gated spectrum, so Preview compares like with
like; ``loudness`` is what is left of it (against the lane with no EQ in
replace mode, against the lane through its current EQ in merge mode).

A lane with too little to measure (under SUGGEST_MIN_GATED_SECONDS of loud
audio, or quieter than SUGGEST_MIN_LANE_LUFS) is refused with
``NotEnoughSignal`` rather than guessed at.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.core.config import (
    FX_MAX_BANDS,
    SUGGEST_MIN_GATED_SECONDS,
    SUGGEST_MIN_LANE_LUFS,
    SUGGEST_OUT_MAX_DB,
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
from app.pipeline.eq_fit import FitResult, fit_eq, nearest_band, weighted_rms_db, weights_for
from app.pipeline.eq_targets import Target
from app.pipeline.fx_filters import (
    BELL,
    HIGHSHELF,
    LOWCUT,
    LOWSHELF,
    OUT_MAX,
    OUT_MIN,
    TILT,
    Band,
    Eq,
)

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
    TILT: ("suggest.why.tiltDarker", "suggest.why.tiltBrighter"),
}


class NotEnoughSignal(ValueError):
    """Too little loud audio to measure. The message is safe to show."""


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
    return {"key": WHY_DISTANCE, "vars": {"before": before, "after": after}}


def _reasons(spec: Spectrum, target: Target, done: _Fitted) -> list[dict]:
    reasons = band_reasons(done.fit)
    if done.new:
        change = round(loudness_change_db(done.base, done.new), _REASON_DECIMALS)
        out = round(done.out - done.ref_out, _REASON_DECIMALS)
        reasons.append({"key": WHY_OUT, "vars": {"d": change, "out": out}})
    else:
        reasons.append({"key": WHY_CLOSE, "vars": {}})
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
    if band.type == TILT:
        return fc >= band.f
    i = nearest_band(band.f)
    mask = np.zeros(N_BANDS, dtype=bool)
    mask[max(0, i - 1) : i + 2] = True
    return mask


def _band_reason(band: Band, dev: np.ndarray, w: np.ndarray) -> dict:
    if band.type == LOWCUT:
        d = round(_mean_dev(dev, w, np.asarray(CENTRES_HZ) < band.f), _REASON_DECIMALS)
        return {"key": WHY_LOW_CUT, "vars": {"f": band.f, "dev": d}}
    key = WHY_BY_TYPE[band.type][band.g >= 0]
    d = round(_mean_dev(dev, w, _band_mask(band)), _REASON_DECIMALS)
    return {"key": key, "vars": {"f": band.f, "g": band.g, "dev": d, "region": region_of(band.f)}}


def band_reasons(fit: FitResult) -> list[dict]:
    """One reason per band, from the numbers: how far the measured spectrum
    is from the target where the band acts (``dev``: measured minus target,
    positive means too much there), and what the band does."""
    return [_band_reason(fb.band, -fit.error_db, fit.weights) for fb in fit.bands]
