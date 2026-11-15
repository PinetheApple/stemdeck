"""Holding a master's true-peak ceiling (app/pipeline/mastering.py).

Coming back down from the limiter's 4x rate rebuilds peaks over its limit, more
the harder it works, and a lossy encoder adds peak of its own. Either way the
correction goes into the limiter: its limit is lowered by the overshoot plus
MASTER_TRIM_MARGIN_DB. On a mix the limiter already works hard, a lower limit
also costs some loudness, so once the limit has moved the pre-limiter gain is
stepped back toward the target in the same bounded loop (at most
MASTER_CEILING_RETRIES passes). Only when a lowered limit still overshoots
after that does a level trim after the limiter take the rest, which costs
loudness. Pure apart from the ``run`` callback.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from app.core.config import (
    MASTER_CEILING_RETRIES,
    MASTER_CORRECTION_MAX_DB,
    MASTER_CORRECTION_TOL_LU,
    MASTER_GAIN_MAX_DB,
    MASTER_GAIN_MIN_DB,
    MASTER_TRIM_MARGIN_DB,
)

if TYPE_CHECKING:
    from app.pipeline.mastering import Loudness

# run(gain_db, limit_offset_db, trim_db) measures the master with those settings.
CeilingRun = Callable[[float, float, float], Awaitable["Loudness"]]
Tries = list[tuple[float, float | None]]
_DB_DECIMALS = 3
# Loudness gained per dB of gain: 1 with no limiting, never assumed below this
# (a limiter at its wall), so a correction step stays bounded.
_LIMITED_SLOPE_MIN = 0.1


def overshoot_db(tp: float | None, ceiling_db: float) -> float:
    """How far to pull a true peak down to sit a margin under the ceiling, 0 when it does."""
    if tp is None or tp <= ceiling_db:
        return 0.0
    return round(tp - ceiling_db + MASTER_TRIM_MARGIN_DB, _DB_DECIMALS)


def loudness_miss(target: float | None, post: Loudness) -> float:
    """How far the loudness is from the target, 0 within tolerance or with no target."""
    if target is None or post.i is None or abs(target - post.i) <= MASTER_CORRECTION_TOL_LU:
        return 0.0
    return target - post.i


def correction_step(miss: float, tried: list[tuple[float, float | None]]) -> float:
    """A bounded gain step toward the target, along the loudness-per-dB slope
    of the last two (gain, loudness) tries; 1 with fewer."""
    slope = 1.0
    if len(tried) > 1:
        (g0, l0), (g1, l1) = tried[-2], tried[-1]
        if g1 != g0 and l0 is not None and l1 is not None:
            slope = min(1.0, max(_LIMITED_SLOPE_MIN, (l1 - l0) / (g1 - g0)))
    step = max(-MASTER_CORRECTION_MAX_DB, min(MASTER_CORRECTION_MAX_DB, miss / slope))
    return round(step, _DB_DECIMALS)


def clamped_gain(gain_db: float) -> float:
    return round(min(MASTER_GAIN_MAX_DB, max(MASTER_GAIN_MIN_DB, gain_db)), _DB_DECIMALS)


async def hold_ceiling(
    gain: float,
    post: Loudness,
    target: float | None,
    ceiling_db: float,
    run: CeilingRun,
) -> tuple[float, float, float, Loudness]:
    """The gain, limit offset and last-resort trim that bring ``post`` under
    the ceiling at the target loudness, and the measurement with them."""
    offset = 0.0
    tried: Tries = [(gain, post.i)]
    for _ in range(MASTER_CEILING_RETRIES):
        over = overshoot_db(post.tp, ceiling_db)
        miss = loudness_miss(target, post) if offset or over else 0.0
        if not over and not miss:
            return gain, offset, 0.0, post
        if over:
            offset, tried = round(offset + over, _DB_DECIMALS), []
        gain = clamped_gain(gain + correction_step(miss, tried))
        post = await run(gain, offset, 0.0)
        tried.append((gain, post.i))
    trim = overshoot_db(post.tp, ceiling_db)
    if trim:
        post = await run(gain, offset, trim)
    return gain, offset, trim, post
