"""The grid playback, export and the song bundle click to.

Two files describe a song's grid. `stems/beats.json` is what analysis found,
including the fitted `tempo` (null when no plausible tempo was found).
`stems/beats.user.json` is the user's: edited `beats` and `bars`, and the
`tempo` fields they set (`mode`, `bpm`, `anchor`, `beats_per_bar`). Re-analysis
rewrites only the first, so user values always win, key by key.

`effective_grid` merges the two into one grid in the song's mode. Constant mode
materialises `beats` and `bars` from the formula; follow mode plays the detected
(or edited) beats, continued at the fitted tempo so they span the whole song.
Either way a reader that only knows `beats` and `bars` plays what StemDeck plays.

A beats.json analysed before tempo existed is fitted once on first read and the
result written back into it, so no request repeats the fit.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from app.core.config import BEAT_TIME_DECIMALS, TEMPO_DEFAULT_BEATS_PER_BAR
from app.pipeline.tempo import (
    MODE_CONSTANT,
    MODE_FOLLOW,
    SOURCE_DETECTED,
    SOURCE_USER,
    constant_beats,
    cover_full_duration,
    fit_constant_tempo,
)

logger = logging.getLogger("stemdeck.tempo")

USER_SETTABLE_KEYS = ("mode", "bpm", "anchor", "beats_per_bar")
DETECTED_KEYS = ("bpm", "anchor", "beats_per_bar")
EDITOR_ONLY_TEMPO_KEYS = ("detected", "user_keys")


def _read_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("ignoring unreadable %s/%s", path.parent.parent.name, path.name)
        return None
    return data if isinstance(data, dict) else None


def write_json_atomic(path: Path, data: dict) -> None:
    """Replace `path` with `data` in one rename. Raises OSError."""
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)


def read_beat_edits(path: Path) -> dict:
    """The user's saved grid edits, or {} when there are none or they are unreadable."""
    return _read_json(path) or {}


def read_detected_grid(path: Path) -> dict | None:
    """stems/beats.json, or None when missing or unreadable.

    A grid analysed before tempo existed gets one fitted and saved into the
    file; a failed save only means the next read fits again.
    """
    grid = _read_json(path)
    if grid is None or "tempo" in grid:
        return grid
    grid["tempo"] = _legacy_tempo(grid)
    try:
        write_json_atomic(path, grid)
    except OSError:
        logger.warning("could not save the fitted tempo into %s", path.parent.parent.name)
    return grid


def _count(grid: dict, key: str) -> int:
    value = grid.get(key)
    return value if isinstance(value, int) and value > 0 else 0


def _legacy_tempo(grid: dict) -> dict | None:
    """Fit a tempo to a grid analysed before beats.json carried one.

    Intro/outro beats the analysis extrapolated are left out by their recorded
    counts. Gap-filled beats are interior and unmarked, so they stay in; they
    sit on the local pulse, which the robust fit tolerates.
    """
    beats = grid.get("beats")
    if not isinstance(beats, list):
        return None
    bars = [
        b
        for b in grid.get("bars") or []
        if isinstance(b, dict) and isinstance(b.get("beat"), int) and 0 <= b["beat"] < len(beats)
    ]
    downbeats = [beats[b["beat"]] for b in bars]
    per_bar = bars[0].get("beats_per_bar") if bars else None
    detected = beats[
        _count(grid, "extrapolated_head") : len(beats) - _count(grid, "extrapolated_tail")
    ]
    return fit_constant_tempo(detected, downbeats, per_bar if isinstance(per_bar, int) else None)


def _user_tempo(edits: dict) -> dict:
    raw = edits.get("tempo")
    if not isinstance(raw, dict):
        return {}
    return {k: raw[k] for k in USER_SETTABLE_KEYS if raw.get(k) is not None}


def _merged_tempo(detected: dict, user: dict, follow_by_default: bool) -> dict:
    tempo = {k: detected[k] for k in USER_SETTABLE_KEYS if k in detected}
    if follow_by_default:
        tempo["mode"] = MODE_FOLLOW
    tempo.update(user)
    tempo.setdefault("mode", MODE_FOLLOW)
    tempo.setdefault("beats_per_bar", TEMPO_DEFAULT_BEATS_PER_BAR)
    tempo["source"] = SOURCE_USER if user else SOURCE_DETECTED
    if "fit" in detected:
        tempo["fit"] = detected["fit"]
    if tempo["mode"] == MODE_CONSTANT and not ("bpm" in tempo and "anchor" in tempo):
        tempo["mode"] = MODE_FOLLOW
    tempo["detected"] = {k: detected.get(k) for k in DETECTED_KEYS} if detected else None
    tempo["user_keys"] = sorted(user)
    return tempo


def _reindex_bars(bars: list, old: list[float], new: list[float]) -> list:
    """Bar marks moved onto the same beat times in a grid that gained beats."""
    index = {t: i for i, t in enumerate(new)}
    out = []
    for mark in bars:
        beat = mark.get("beat") if isinstance(mark, dict) else None
        if isinstance(beat, int) and 0 <= beat < len(old):
            out.append({**mark, "beat": index[old[beat]]})
    return out


def _apply_constant(out: dict, tempo: dict, duration: float) -> None:
    out["beats"], anchor_index = constant_beats(tempo["bpm"], tempo["anchor"], duration)
    per_bar = tempo["beats_per_bar"]
    out["bars"] = [{"beat": anchor_index % per_bar, "beats_per_bar": per_bar}]
    out["bpm"] = tempo["bpm"]


def _apply_follow(out: dict, tempo: dict, duration: float, bar_lines_from_user: bool) -> None:
    old = [round(float(t), BEAT_TIME_DECIMALS) for t in out["beats"]]
    if not old:
        return
    covered, *_ = cover_full_duration(old, 60.0 / tempo["bpm"], duration)
    out["beats"] = [round(t, BEAT_TIME_DECIMALS) for t in covered]
    if len(out["beats"]) != len(old):
        out["bars"] = _reindex_bars(out["bars"], old, out["beats"])
    if bar_lines_from_user and "anchor" in tempo:
        beats = out["beats"]
        nearest = min(range(len(beats)), key=lambda i: abs(beats[i] - tempo["anchor"]))
        per_bar = tempo["beats_per_bar"]
        out["bars"] = [{"beat": nearest % per_bar, "beats_per_bar": per_bar}]


def effective_grid(grid: dict, edits: dict | None) -> dict:
    """The stored grid with the user's edits and tempo applied, in the song's mode.

    Edited beats are followed unless the user chose a mode. In follow mode a
    user anchor or meter sets the bar line unless the user edited bars.
    """
    edits = edits or {}
    out = dict(grid)
    edited_beats = edits.get("beats") if isinstance(edits.get("beats"), list) else None
    edited_bars = bool(edited_beats and edits.get("bars"))
    if edited_beats:
        out["beats"] = edited_beats
        out["bars"] = edits.get("bars") or []
    out.setdefault("bars", [])

    user = _user_tempo(edits)
    follow_edits = bool(edited_beats) and "mode" not in user
    tempo = _merged_tempo(grid.get("tempo") or {}, user, follow_edits)
    out["edited"] = bool(edited_beats or user)

    duration = float(grid.get("duration") or 0.0)
    if tempo["mode"] == MODE_CONSTANT:
        _apply_constant(out, tempo, duration)
    elif "bpm" in tempo:
        bar_lines_from_user = not edited_bars and bool({"anchor", "beats_per_bar"} & user.keys())
        _apply_follow(out, tempo, duration, bar_lines_from_user)
    out["tempo"] = tempo
    return out
