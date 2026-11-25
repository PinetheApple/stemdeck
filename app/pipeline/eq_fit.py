"""Suggest EQ: turn "measured spectrum minus target" into a few ordinary EQ bands.

The output is nothing but the studio EQ's own bands, designed by the engine's
maths (fx_filters.py), so a suggestion is an EQ the user can see, drag,
preview, keep or undo. The fit works on the 31 third-octave bands:

1. Error = target - measured, level removed (only the shape is compared),
   clipped and smoothed over 2/3 octave, so one resonance is not chased.
2. Only what lies outside a tolerance range around the target (TOL_DB) is
   asked for; too little bass is tolerated more than too much.
3. Bands count by how much signal they hold. Where the lane lacks
   SUGGEST_BOOST_DEFICIT_NONE_DB or more against the target the content is
   missing, not dull: no candidate may lift such a band (its summed response
   there stays under INAUDIBLE_DB), and boosts fade in up to
   SUGGEST_BOOST_DEFICIT_FULL_DB. Cuts are allowed anywhere.
4. Greedy: the candidate band (each slot's type, nominal frequencies and Qs)
   that lowers the cost most is added, its gain by weighted least squares on
   the gain grid, while it improves the cost enough; then every band is
   refined. A per-band penalty makes big bands earn their size, same-type
   bands stay apart and the whole curve stays within SUGGEST_COMBINED_MAX_DB.
5. Loudness-neutral: the output gain cancels the K-weighted loudness change.

One layout, "free": the graphical panels every lane and the master use.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace

import numpy as np

from app.core.config import (
    SUGGEST_BAND_PENALTY,
    SUGGEST_BASS_LOW_HZ,
    SUGGEST_BASS_SHORT_FACTOR,
    SUGGEST_BOOST_DEFICIT_FULL_DB,
    SUGGEST_BOOST_DEFICIT_NONE_DB,
    SUGGEST_COMBINED_MAX_DB,
    SUGGEST_CROWD_OCTAVES,
    SUGGEST_ERROR_CLIP_DB,
    SUGGEST_GAIN_MAX_DB,
    SUGGEST_GAIN_STEP_DB,
    SUGGEST_MAX_BANDS_LANE,
    SUGGEST_MIN_GAIN_DB,
    SUGGEST_MIN_IMPROVEMENT_ABS,
    SUGGEST_MIN_IMPROVEMENT_REL,
    SUGGEST_REFINE_ROUNDS,
)
from app.pipeline.eq_analysis import CENTRES_HZ, N_BANDS, NOMINAL_HZ, band_response_db
from app.pipeline.fx_filters import BELL, DEFAULT_Q, HIGHSHELF, LOWCUT, LOWSHELF, Band

FREE = "free"
SLOPE = 12
FREE_Q = (0.7, 1.0, 1.4, 2.0)
# The per-dB shape of a band is taken between these gains, and the penalty
# counts gain in units of this many dB.
_SHAPE_PROBE_DB = 3.0
_PENALTY_UNIT_DB = 6.0
# Weights: full within this of the loudest band, none this far below it.
_AUDIBLE_RANGE_DB = 45.0
_AUDIBLE_FADE_DB = 15.0
# From this band (40 Hz) up the combined curve is limited; a low cut may go deeper below.
_COMBINED_FROM_BAND = 3
_EPS = 1e-9

# Wider in the bass and the top octave, where songs differ most.
TOL_DB = np.array(
    [5.0, 5.0, 5.0, 4.5, 4.0, 3.5, 3.0, 2.5, 2.0, 1.5, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
     1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 2.5, 2.5, 3.0, 3.5, 4.0, 5.0]
)  # fmt: skip
_BASS_BANDS = np.asarray(CENTRES_HZ) < SUGGEST_BASS_LOW_HZ

_EDGE_WEIGHT_LOW = 0.25
_EDGE_WEIGHT_HALF = 0.5
_EDGE_BANDS_LOW = [0, 1, 30]
_EDGE_BANDS_HALF = [2, 29]
_BASE_W = np.ones(N_BANDS)
_BASE_W[_EDGE_BANDS_LOW] = _EDGE_WEIGHT_LOW
_BASE_W[_EDGE_BANDS_HALF] = _EDGE_WEIGHT_HALF
# A summed response under this is no boost: a shelf's far tail is not a lift.
INAUDIBLE_DB = 0.1
_CROWD_SLACK_OCT = 1e-6
_GAIN_DECIMALS = 2
_SMOOTH_KERNEL = (0.25, 0.5, 0.25)


def _nominal_between(lo: float, hi: float) -> tuple[float, ...]:
    return tuple(float(f) for f in NOMINAL_HZ if lo <= f <= hi)


def nearest_band(f: float) -> int:
    """The third-octave band whose centre is closest to ``f`` (in octaves)."""
    return int(np.argmin(np.abs(np.log2(np.asarray(CENTRES_HZ) / f))))


@dataclass(frozen=True)
class Slot:
    """One place a suggested band may go. ``reuse``: any number of bands of
    this kind (bells); otherwise one at most (a shelf, the low cut)."""

    id: str
    type: str
    freqs: tuple[float, ...]
    qs: tuple[float, ...] = (DEFAULT_Q,)
    reuse: bool = False

    @property
    def gainless(self) -> bool:
        return self.type == LOWCUT


# Nominal-frequency ranges (Hz) per slot.
_FREE_HZ = {"bell": (40, 16000), "lowshelf": (63, 250), "highshelf": (2000, 10000)}
_FREE_LOWCUT_HZ = (25, 125)

_FREE = (
    Slot("bell", BELL, _nominal_between(*_FREE_HZ["bell"]), FREE_Q, reuse=True),
    # One shelf of each kind: two stacked shelves read as one, less clearly.
    Slot("lowshelf", LOWSHELF, _nominal_between(*_FREE_HZ["lowshelf"])),
    Slot("highshelf", HIGHSHELF, _nominal_between(*_FREE_HZ["highshelf"])),
)
LAYOUTS: dict[str, tuple[Slot, ...]] = {
    FREE: (*_FREE, Slot("lowcut", LOWCUT, _nominal_between(*_FREE_LOWCUT_HZ))),
}


@dataclass(frozen=True)
class FitBand:
    slot: str
    band: Band


@dataclass
class FitResult:
    bands: list[FitBand] = field(default_factory=list)
    error_db: np.ndarray = field(default_factory=lambda: np.zeros(N_BANDS))
    weights: np.ndarray = field(default_factory=lambda: np.zeros(N_BANDS))
    boost_ok: np.ndarray = field(default_factory=lambda: np.ones(N_BANDS))


def weights_for(measured_db: np.ndarray) -> np.ndarray:
    floor = float(np.max(measured_db)) - _AUDIBLE_RANGE_DB
    return _BASE_W * np.clip((measured_db - floor) / _AUDIBLE_FADE_DB, 0.0, 1.0)


def _demean(x: np.ndarray, w: np.ndarray) -> np.ndarray:
    sw = float(w.sum())
    return x - (float(w @ x) / sw if sw > 0 else 0.0)


def _mean_square(r: np.ndarray, w: np.ndarray) -> float:
    sw = float(w.sum())
    return float(w @ (r * r)) / sw if sw > 0 else 0.0


def tolerated_error(error: np.ndarray, boost_ok=None, scale: float = 1.0) -> np.ndarray:
    """The part of the error outside the tolerance range (soft threshold).
    A positive error (measured under the target) asks for a boost; below
    SUGGEST_BASS_LOW_HZ a lack is tolerated more. ``boost_ok`` (0..1 per band)
    scales what a boost may be asked for."""
    tol = TOL_DB * scale
    tol_up = np.where(_BASS_BANDS, tol * SUGGEST_BASS_SHORT_FACTOR, tol)
    up = np.maximum(0.0, error - tol_up)
    if boost_ok is not None:
        up = up * boost_ok
    return np.where(error > 0, up, np.minimum(0.0, error + tol))


def _tcost(resid: np.ndarray, w: np.ndarray, boost_ok=None, scale: float = 1.0) -> float:
    """The fit's cost: weighted mean square of what lies outside the
    tolerance range, after the level is removed."""
    return _mean_square(tolerated_error(_demean(resid, w), boost_ok, scale), w)


def weighted_rms_db(diff: np.ndarray, w: np.ndarray) -> float:
    """RMS deviation (dB) with the level removed: the distance to a target."""
    return math.sqrt(_mean_square(_demean(np.asarray(diff, dtype=np.float64), w), w))


def _level_removed_error(measured_db, target_db, w: np.ndarray) -> np.ndarray:
    return _demean(np.asarray(target_db, float) - np.asarray(measured_db, float), w)


def _smooth(e: np.ndarray) -> np.ndarray:
    """Over three neighbouring bands (2/3 octave)."""
    padded = np.concatenate([[e[0]], e, [e[-1]]])
    left, centre, right = _SMOOTH_KERNEL
    return left * padded[:-2] + centre * padded[1:-1] + right * padded[2:]


def smoothed_error(measured_db, target_db, w: np.ndarray) -> np.ndarray:
    """Target minus measured, level removed, clipped and smoothed."""
    e = _level_removed_error(measured_db, target_db, w)
    return _smooth(np.clip(e, -SUGGEST_ERROR_CLIP_DB, SUGGEST_ERROR_CLIP_DB))


def boost_allowed(measured_db, target_db) -> np.ndarray:
    """Where a boost may be suggested (0..1 per band): full up to
    SUGGEST_BOOST_DEFICIT_FULL_DB under the target, none from
    SUGGEST_BOOST_DEFICIT_NONE_DB (level removed). The deficit is neither
    clipped (the clip sits under the cut-off) nor only smoothed (that halves
    it at the edge of a hole): each band takes the worse of its own and the
    smoothed value."""
    m = np.asarray(measured_db, dtype=float)
    e = _level_removed_error(m, target_db, weights_for(m))
    deficit = np.maximum(e, _smooth(e))
    span = SUGGEST_BOOST_DEFICIT_NONE_DB - SUGGEST_BOOST_DEFICIT_FULL_DB
    return np.clip((SUGGEST_BOOST_DEFICIT_NONE_DB - deficit) / span, 0.0, 1.0)


def make_band(slot: Slot, f: float, g: float, q: float) -> Band:
    return Band(slot.type, float(f), float(g), float(q), SLOPE)


def _round_gain(g: float) -> float:
    g = max(-SUGGEST_GAIN_MAX_DB, min(SUGGEST_GAIN_MAX_DB, g))
    return round(round(g / SUGGEST_GAIN_STEP_DB) * SUGGEST_GAIN_STEP_DB, _GAIN_DECIMALS)


def penalty(g: float) -> float:
    return SUGGEST_BAND_PENALTY * (g / _PENALTY_UNIT_DB) ** 2


def too_much(curve: np.ndarray) -> bool:
    """The whole suggestion's curve may not pass SUGGEST_COMBINED_MAX_DB at
    any band from 40 Hz up."""
    return bool(np.max(np.abs(curve[_COMBINED_FROM_BAND:])) > SUGGEST_COMBINED_MAX_DB)


@dataclass(frozen=True)
class Pick:
    """A chosen band: its slot, frequency, gain, Q and response on the 31 bands."""

    slot: Slot
    f: float
    g: float
    q: float
    resp: np.ndarray
    cost: float = 0.0


def crowded(chosen: list[Pick], slot: Slot, f: float) -> bool:
    """Two bands of one type closer than SUGGEST_CROWD_OCTAVES would add up
    past the gain limit."""
    return any(
        c.slot.type == slot.type
        and abs(math.log2(c.f / f)) < SUGGEST_CROWD_OCTAVES - _CROWD_SLACK_OCT
        for c in chosen
    )


def _gain_candidates(g0: float) -> list[float]:
    """The least-squares gain and its neighbours on the gain grid, each big
    enough to be worth a handle."""
    grid = (_round_gain(g0 + d) for d in (-SUGGEST_GAIN_STEP_DB, 0.0, SUGGEST_GAIN_STEP_DB))
    return [g for g in grid if abs(g) >= SUGGEST_MIN_GAIN_DB]


class _Fitter:
    """The greedy search over one layout's slots; ``chosen`` holds the picks."""

    def __init__(self, error, w, boost_ok, scale: float, slots) -> None:
        self.error, self.w, self.boost_ok, self.scale = error, w, boost_ok, scale
        self.blocked = boost_ok <= 0
        self.slots: tuple[Slot, ...] = slots
        self.chosen: list[Pick] = []
        self._cache: dict[tuple, np.ndarray] = {}

    def resp(self, slot: Slot, f: float, g: float, q: float) -> np.ndarray:
        key = (slot.id, slot.type, f, g, q)
        if key not in self._cache:
            self._cache[key] = band_response_db(make_band(slot, f, g, q))
        return self._cache[key]

    def cost_of(self, resid: np.ndarray) -> float:
        return _tcost(resid, self.w, self.boost_ok, self.scale)

    def total(self, skip: int = -1) -> np.ndarray:
        return sum((c.resp for k, c in enumerate(self.chosen) if k != skip), np.zeros(N_BANDS))

    def penalties(self, skip: int = -1) -> float:
        return sum(penalty(c.g) for k, c in enumerate(self.chosen) if k != skip)

    def full_cost(self) -> float:
        return self.cost_of(self.error - self.total()) + self.penalties()

    def _ls_gain(self, slot: Slot, f: float, q: float, target: np.ndarray) -> float | None:
        """Least squares on the band's per-dB shape (its dB response is close
        to linear and odd in the gain) against what is outside the tolerance."""
        up, down = self.resp(slot, f, _SHAPE_PROBE_DB, q), self.resp(slot, f, -_SHAPE_PROBE_DB, q)
        s = _demean((up - down) / (2 * _SHAPE_PROBE_DB), self.w)
        tdm = tolerated_error(_demean(target, self.w), self.boost_ok, self.scale)
        ridge = SUGGEST_BAND_PENALTY / _PENALTY_UNIT_DB**2 * float(self.w.sum())
        denom = float(self.w @ (s * s)) + ridge
        return None if denom <= 0 else _round_gain(float(self.w @ (s * tdm)) / denom)

    def boost_cap(self, f: float) -> float:
        """The most a band centred at ``f`` may boost: none where the content
        there is missing, a share of the limit where it is fading."""
        return SUGGEST_GAIN_MAX_DB * float(self.boost_ok[nearest_band(f)])

    def lifts_missing(self, curve: np.ndarray) -> bool:
        """Whether the summed response lifts any band whose content is missing."""
        return bool(np.any(curve[self.blocked] > INAUDIBLE_DB))

    def _allowed(self, curve: np.ndarray) -> bool:
        return not too_much(curve) and not self.lifts_missing(curve)

    def _gainful(self, slot: Slot, f: float, q: float, rest: np.ndarray) -> Pick | None:
        target, cap = self.error - rest, self.boost_cap(f)
        g0 = self._ls_gain(slot, f, q, target)
        best = None
        for g in [] if g0 is None else _gain_candidates(g0):
            r = self.resp(slot, f, g, q)
            if g > cap or not self._allowed(rest + r):
                continue
            cost = self.cost_of(target - r) + penalty(g)
            if best is None or cost < best.cost:
                best = Pick(slot, f, g, q, r, cost)
        return best

    def best_for(self, slot: Slot, f: float, q: float, rest: np.ndarray) -> Pick | None:
        """The best band of this shape given the others' response ``rest``;
        its cost includes its own penalty."""
        if not slot.gainless:
            return self._gainful(slot, f, q, rest)
        r = self.resp(slot, f, 0.0, q)
        if not self._allowed(rest + r):
            return None
        return Pick(slot, f, 0.0, q, r, self.cost_of(self.error - rest - r))

    def _candidates(self):
        used = {c.slot.id for c in self.chosen}
        for slot in self.slots:
            if not slot.reuse and slot.id in used:
                continue
            for f in slot.freqs:
                if not crowded(self.chosen, slot, f):
                    yield from ((slot, f, q) for q in slot.qs)

    def best_addition(self) -> Pick | None:
        rest, others = self.total(), self.penalties()
        best = None
        for slot, f, q in self._candidates():
            got = self.best_for(slot, f, q, rest)
            if got is not None and (best is None or got.cost + others < best.cost):
                best = replace(got, cost=got.cost + others)
        return best

    def refine(self, k: int) -> None:
        """Move pick ``k`` a frequency step either way, or change its Q or
        gain, when that lowers the whole cost."""
        pick, others = self.chosen[k], self.chosen[:k] + self.chosen[k + 1 :]
        rest, others_penalty = self.total(skip=k), self.penalties(skip=k)
        i = pick.slot.freqs.index(pick.f)
        best = None
        for f in pick.slot.freqs[max(0, i - 1) : i + 2]:
            if crowded(others, pick.slot, f):
                continue
            for q in pick.slot.qs:
                got = self.best_for(pick.slot, f, q, rest)
                if got is not None and (best is None or got.cost < best.cost):
                    best = got
        if best is not None and best.cost + others_penalty < self.full_cost() - _EPS:
            self.chosen[k] = best

    def run(self, max_bands: int) -> None:
        current = self.full_cost()
        while len(self.chosen) < max_bands:
            best = self.best_addition()
            if best is None or current - best.cost < min_improvement(current):
                return
            self.chosen.append(best)
            for _ in range(SUGGEST_REFINE_ROUNDS):
                for k in range(len(self.chosen)):
                    self.refine(k)
            current = self.full_cost()


def min_improvement(cost: float) -> float:
    return max(SUGGEST_MIN_IMPROVEMENT_ABS, SUGGEST_MIN_IMPROVEMENT_REL * cost)


def _kept_in_order(chosen: list[Pick]) -> list[Pick]:
    """Bands that refining left tiny are not worth a handle; the rest by frequency."""
    kept = [c for c in chosen if c.slot.gainless or abs(c.g) >= SUGGEST_MIN_GAIN_DB]
    return sorted(kept, key=lambda c: c.f)


def fit_eq(
    measured_db,
    target_db,
    layout: str = FREE,
    max_bands: int = SUGGEST_MAX_BANDS_LANE,
    tolerance: float = 1.0,
    boost_ref=None,
) -> FitResult:
    """Fit a few bands of ``layout`` so the measured third-octave levels move
    towards the target (31 levels each, any offset). ``tolerance`` scales the
    tolerance range (0: fit the line itself). ``boost_ref``: the levels that
    decide where a boost may go (default the measured ones); a fit on top of
    an EQ passes the lane's raw levels, so an applied boost makes no room for more."""
    measured = np.asarray(measured_db, dtype=np.float64)
    w = weights_for(measured)
    error = smoothed_error(measured, target_db, w)
    ref = measured if boost_ref is None else np.asarray(boost_ref, dtype=np.float64)
    boost_ok = boost_allowed(ref, target_db)
    fitter = _Fitter(error, w, boost_ok, tolerance, LAYOUTS[layout])
    fitter.run(max_bands)
    picks = _kept_in_order(fitter.chosen)
    bands = [FitBand(c.slot.id, make_band(c.slot, c.f, c.g, c.q)) for c in picks]
    return FitResult(bands, error, w, boost_ok)


def target_gap(fit: FitResult) -> np.ndarray:
    """The correction the target asks for per band, as the fit sees it: level
    removed, only what lies outside the tolerance, 0 where content is missing."""
    gap = tolerated_error(_demean(fit.error_db, fit.weights), fit.boost_ok)
    return np.where(fit.boost_ok > 0, gap, 0.0)
