"""Constant tempo: one BPM for the whole song, and the grid it implies.

The detected grid reproduces everything the tracker heard -- real drift, its own
jitter, and on live material whole sections tracked at half or double time (Worthy
Is The Lamb alternates 136 and 68 BPM stretches). A player in time with the band
then hears a click that wanders. Constant mode instead plays

    beat n = anchor + n * 60 / bpm,   for every n whose time falls in [0, duration]

where `anchor` is a downbeat. The grid and the click both come from that one
formula, so they cannot disagree.

The fit is Theil-Sen over (beat number, time): the median of all pairwise slopes,
then the median intercept. Beat numbers come from counting reference periods
between detected beats, so a half-time stretch skips numbers and a double-time
stretch drops its extra beats rather than bending the line. Theil-Sen tolerates up
to 29% wild points with no tuning constant; on the real songs a ritardando outro
or a one-beat numbering slip across 15% of the song moves it under 0.01 BPM, where
least squares moves 0.2-0.4 BPM and drifts the body of the song 65-190 ms.

This module is the maths only; app/pipeline/tempo_grid.py merges it with the
stored grid and the user's settings.
"""

from __future__ import annotations

import math

from app.core.config import (
    BEAT_TIME_DECIMALS,
    TEMPO_BPM_DECIMALS,
    TEMPO_DEFAULT_BEATS_PER_BAR,
    TEMPO_DOWNBEAT_TOL,
    TEMPO_EDGE_EPS,
    TEMPO_FIT_MAX_POINTS,
    TEMPO_FOLLOW_FILL_GAP,
    TEMPO_MAX_BAR,
    TEMPO_MAX_BPM,
    TEMPO_MIN_BAR,
    TEMPO_MIN_BPM,
    TEMPO_NUMBER_TOL,
)

MODE_CONSTANT = "constant"
MODE_FOLLOW = "follow"
SOURCE_DETECTED = "detected"
SOURCE_USER = "user"
FIT_METHOD = "theil-sen"
_MS = 1000.0


def number_beats(beats: list[float], period: float) -> tuple[list[int], list[float]]:
    """Beat numbers in units of `period`, for the beats that sit on that pulse.

    A beat less than (1 - TEMPO_NUMBER_TOL) periods after the last counted one is
    an extra beat from a double-time stretch and is dropped. Anything later is
    counted with the nearest whole number of periods, so a half-time stretch or a
    drum-free hole advances the count by the beats it skipped.
    """
    if not beats or period <= 0:
        return [], []
    numbers = [0]
    times = [float(beats[0])]
    for t in beats[1:]:
        ratio = (float(t) - times[-1]) / period
        if ratio < 1.0 - TEMPO_NUMBER_TOL:
            continue
        numbers.append(numbers[-1] + max(1, math.floor(ratio + 0.5)))
        times.append(float(t))
    return numbers, times


def _theil_sen(numbers: list[int], times: list[float]) -> tuple[float, float]:
    """(intercept, slope) of time against beat number."""
    import numpy as np

    n = np.asarray(numbers, dtype=float)
    t = np.asarray(times, dtype=float)
    if n.size > TEMPO_FIT_MAX_POINTS:
        pick = np.unique(np.linspace(0, n.size - 1, TEMPO_FIT_MAX_POINTS).round().astype(int))
        n, t = n[pick], t[pick]
    i, j = np.triu_indices(n.size, 1)
    slope = float(np.median((t[j] - t[i]) / (n[j] - n[i])))
    intercept = float(np.median(t - slope * n))
    return intercept, slope


def _downbeat_numbers(
    numbers: list[int], times: list[float], downbeats: list[float], period: float
) -> list[int]:
    """Beat numbers of the counted beats that a detected downbeat lands on."""
    import numpy as np

    if not downbeats or not times:
        return []
    t = np.asarray(times, dtype=float)
    found: set[int] = set()
    for d in downbeats:
        k = int(np.abs(t - float(d)).argmin())
        if abs(t[k] - float(d)) <= TEMPO_DOWNBEAT_TOL * period:
            found.add(numbers[k])
    return sorted(found)


def _bar_layout(down: list[int], beats_per_bar: int | None) -> tuple[int, int | None]:
    """(beats per bar, bar phase in beat numbers), from the downbeat numbers.

    The modal spacing between detected downbeats is the meter unless one was
    given, and the modal remainder is where bar lines fall. The phase is None
    when no downbeat was detected.
    """
    from collections import Counter

    if beats_per_bar is None:
        spans = [b - a for a, b in zip(down, down[1:], strict=False)]
        spans = [s for s in spans if TEMPO_MIN_BAR <= s <= TEMPO_MAX_BAR]
        beats_per_bar = (
            Counter(spans).most_common(1)[0][0] if spans else TEMPO_DEFAULT_BEATS_PER_BAR
        )
    if not down:
        return beats_per_bar, None
    phase = Counter(n % beats_per_bar for n in down).most_common(1)[0][0]
    return beats_per_bar, phase


def fit_constant_tempo(
    beats: list[float], downbeats: list[float], beats_per_bar: int | None = None
) -> dict | None:
    """Fit one tempo to the detected beats and anchor it on a downbeat.

    `beats` must be detected beats only: a beat invented by gap filling or edge
    extension carries the tempo it was invented at, not evidence of the song's.
    The anchor is the fitted time of the first bar line at or after the first
    counted beat -- the line, not the detected downbeat itself, because the line
    is where the whole song's evidence puts that beat. Returns None when the
    beats describe no plausible tempo.
    """
    import numpy as np

    if len(beats) < 2:
        return None
    reference = float(np.median(np.diff(np.asarray(beats, dtype=float))))
    numbers, times = number_beats(beats, reference)
    if len(numbers) < 2:
        return None
    intercept, slope = _theil_sen(numbers, times)
    if slope <= 0 or not (TEMPO_MIN_BPM <= 60.0 / slope <= TEMPO_MAX_BPM):
        return None

    down = _downbeat_numbers(numbers, times, downbeats, slope)
    per_bar, phase = _bar_layout(down, beats_per_bar)
    first = numbers[0]
    anchor_number = first if phase is None else first + (phase - first) % per_bar
    anchor = intercept + slope * anchor_number
    if anchor < 0:
        anchor += per_bar * slope

    drift = np.abs(
        np.asarray(times, dtype=float) - (intercept + slope * np.asarray(numbers, dtype=float))
    )
    return {
        "mode": MODE_CONSTANT,
        "bpm": round(60.0 / slope, TEMPO_BPM_DECIMALS),
        "anchor": round(anchor, BEAT_TIME_DECIMALS),
        "beats_per_bar": per_bar,
        "source": SOURCE_DETECTED,
        "fit": {
            "method": FIT_METHOD,
            "beats_used": len(numbers),
            "downbeats_used": len(down),
            "max_drift_ms": round(float(drift.max()) * _MS, 1),
            "median_drift_ms": round(float(np.median(drift)) * _MS, 1),
        },
    }


def constant_beats(bpm: float, anchor: float, duration: float) -> tuple[list[float], int]:
    """Every `anchor + n * 60 / bpm` in [0, duration], and the anchor's index.

    Readers that rebuild the grid from the tempo object (static/js) must use
    exactly this: n from -floor(anchor / period) to floor((duration - anchor) /
    period), each time rounded to 6 decimals.
    """
    period = 60.0 / bpm
    first = -math.floor(anchor / period + TEMPO_EDGE_EPS)
    last = math.floor((duration - anchor) / period + TEMPO_EDGE_EPS)
    out = [round(anchor + n * period, BEAT_TIME_DECIMALS) for n in range(first, last + 1)]
    return [t for t in out if 0.0 <= t <= duration], -first


def cover_full_duration(
    beats: list[float], period: float, duration: float
) -> tuple[list[float], int, int, int]:
    """Continue a detected grid over the whole song at the fitted period.

    Holes longer than TEMPO_FOLLOW_FILL_GAP periods are split evenly into the
    nearest whole number of beats, pinned to the detected beats either side; the
    intro and outro are continued outward from the first and last beat. Returns
    (beats, head_added, tail_added, filled).
    """
    if not beats or period <= 0:
        return beats, 0, 0, 0
    head: list[float] = []
    t = beats[0] - period
    while t >= 0.0:
        head.append(t)
        t -= period
    head.reverse()

    body: list[float] = [beats[0]]
    filled = 0
    for a, b in zip(beats, beats[1:], strict=False):
        gap = b - a
        if gap > TEMPO_FOLLOW_FILL_GAP * period:
            k = max(2, math.floor(gap / period + 0.5))
            body.extend(a + gap * j / k for j in range(1, k))
            filled += k - 1
        body.append(b)

    tail: list[float] = []
    t = beats[-1] + period
    while t <= duration:
        tail.append(t)
        t += period
    return head + body + tail, len(head), len(tail), filled
