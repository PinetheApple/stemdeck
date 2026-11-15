"""Recorded takes as export lanes, for the mixdown, video and zip routes.

A lane is a stem name, a take id, or a track id that plays its active take.
A take lane is already aligned and in the stems' format, so an export applies
no offset, resample or transpose to it. Pure lookups: the callers decide the
status codes.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import NamedTuple

from app.core.takes import is_finished, read_json, read_tracks
from app.core.takes_config import (
    SIDECAR_FILE,
    TAKE_ID_RE,
    TAKE_WAV_FILE,
    TAKES_DIRNAME,
    TRACK_ID_RE,
)

# Headroom for the overshoot a lossy encoder adds on top of the ceiling.
EXPORT_CEILING_DBFS = -1.0
_DB_PER_AMPLITUDE_DECADE = 20
EXPORT_CEILING = 10 ** (EXPORT_CEILING_DBFS / _DB_PER_AMPLITUDE_DECADE)
# level=disabled stops alimiter re-normalising the output; latency=1 removes
# its look-ahead delay, so lanes keep their timing.
EXPORT_LIMITER = f"alimiter=limit={EXPORT_CEILING:.6f}:level=disabled:latency=1"
NO_SHIFT = 0
MIX_LABEL = "[mix]"
FIRST_LANE_LABEL = "[a0]"


def is_take_lane(name: str) -> bool:
    return bool(TAKE_ID_RE.match(name) or TRACK_ID_RE.match(name))


def has_take_lane(names: Iterable[str]) -> bool:
    return any(is_take_lane(n) for n in names)


def zero_take_pitches(names: list[str], pitches: list[int]) -> list[int]:
    """`pitches` with every take lane's shift dropped: a take is never transposed."""
    return [NO_SHIFT if is_take_lane(n) else p for n, p in zip(names, pitches, strict=True)]


def _track(job_dir: Path, track_id: str) -> dict | None:
    return next((t for t in read_tracks(job_dir) if t.get("id") == track_id), None)


def _lane_take_id(job_dir: Path, name: str) -> str | None:
    if TAKE_ID_RE.match(name):
        return name
    if not TRACK_ID_RE.match(name):
        return None
    track = _track(job_dir, name)
    active = track.get("active_take_id") if track else None
    return active if isinstance(active, str) and TAKE_ID_RE.match(active) else None


class TakeLane(NamedTuple):
    """The finished take a lane plays: a take id plays itself, a track id its
    active take."""

    take_id: str
    path: Path


def resolve_take_lane(job_dir: Path, name: str) -> TakeLane | None:
    """The take a take or track lane plays, or None when the lane names no
    finished take of this song (unknown id, a track with no take yet, a take
    still recording)."""
    take_id = _lane_take_id(job_dir, name)
    if take_id is None:
        return None
    folder = (job_dir / TAKES_DIRNAME / take_id).resolve()
    if not folder.is_relative_to(job_dir.resolve()) or not is_finished(folder):
        return None
    return TakeLane(take_id, folder / TAKE_WAV_FILE)


def take_lane_versions(job_dir: Path, names: Iterable[str]) -> list[str]:
    """Cache-key fragments for the take lanes in `names`. A take re-placed by a
    nudge is rewritten under the same name, and a track can switch its active
    take, so the take id, size and mtime pin the file the render read. Empty
    for a mix of stems only, which keeps its cache key unchanged."""
    out: list[str] = []
    for name in names:
        lane = resolve_take_lane(job_dir, name) if is_take_lane(name) else None
        if lane is None:
            continue
        st = lane.path.stat()
        out.append(f"{name}={lane.take_id}@{st.st_size}:{st.st_mtime_ns}")
    return out


def take_lane_label(job_dir: Path, name: str) -> str | None:
    """What the user called a take lane: a track's name, a take's label. None
    for anything else, so a zip entry can fall back to the bare id."""
    if TRACK_ID_RE.match(name):
        track = _track(job_dir, name)
        return track.get("name") if track else None
    if TAKE_ID_RE.match(name):
        return read_json(job_dir / TAKES_DIRNAME / name / SIDECAR_FILE).get("label")
    return None


def limiter_filter(names: Iterable[str]) -> str:
    """The suffix for the summed output's filter chain: the export limiter when
    a take is in the mix, else "". It goes right after `amix=...` before the
    `[mix]` label, or on the single lane's chain when there is no amix, so a
    stems-only export stays byte-identical."""
    return f",{EXPORT_LIMITER}" if has_take_lane(names) else ""


def sum_lanes(filters: list[str], lane_count: int, names: Iterable[str]) -> str:
    """Append the summing step for lanes [a0]..[aN-1] to `filters` and return
    the output label: amix for several lanes, then the export limiter when a
    take is in the mix. A single stem lane is passed through untouched."""
    limiter = limiter_filter(names)
    if lane_count > 1:
        labels = "".join(f"[a{i}]" for i in range(lane_count))
        filters.append(f"{labels}amix=inputs={lane_count}:normalize=0{limiter}{MIX_LABEL}")
        return MIX_LABEL
    if limiter:
        filters.append(f"{FIRST_LANE_LABEL}{limiter.removeprefix(',')}{MIX_LABEL}")
        return MIX_LABEL
    return FIRST_LANE_LABEL
