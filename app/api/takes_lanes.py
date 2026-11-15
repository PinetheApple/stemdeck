"""Recorded takes as export lanes, for the mixdown, video and zip routes in
app/api/stems.py to call into.

A lane name is a stem name, a take id (^t...$) or a recording track id
(^k...$, which plays its active take). The two id patterns can never match a
stem name, so they share the `stems=` list with the stems. A take's audio.wav
is already in the stems' format, aligned to song 0 and the song's length, so
an export applies no offset and no resample to it, and never a transpose:
the take was recorded in the key the user heard.

Pure lookups over the files (app.core.takes): no FastAPI, so the stems.py
call sites decide the status codes (an unresolvable take lane is the same 422
as an unknown stem).
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from app.core.takes import is_finished, read_tracks
from app.core.takes_config import (
    EXPORT_LIMIT_DBFS,
    TAKE_ID_RE,
    TAKE_WAV_FILE,
    TAKES_DIRNAME,
    TRACK_ID_RE,
)

# alimiter's limit is linear. level=disabled stops it re-normalising the
# output, and latency=1 removes its look-ahead delay so lanes keep their timing.
EXPORT_LIMITER = f"alimiter=limit={10 ** (EXPORT_LIMIT_DBFS / 20):.6f}:level=disabled:latency=1"


def is_take_lane(name: str) -> bool:
    return bool(TAKE_ID_RE.match(name) or TRACK_ID_RE.match(name))


def has_take_lane(names: Iterable[str]) -> bool:
    return any(is_take_lane(n) for n in names)


def _lane_take_id(job_dir: Path, name: str) -> str | None:
    if TAKE_ID_RE.match(name):
        return name
    if not TRACK_ID_RE.match(name):
        return None
    track = next((t for t in read_tracks(job_dir) if t.get("id") == name), None)
    active = track.get("active_take_id") if track else None
    return active if isinstance(active, str) and TAKE_ID_RE.match(active) else None


def take_lane_path(job_dir: Path, name: str) -> Path | None:
    """The audio.wav a take or track lane plays, or None when the lane names
    no finished take of this song (unknown id, a track with no take yet, a
    take still recording)."""
    take_id = _lane_take_id(job_dir, name)
    if take_id is None:
        return None
    folder = (job_dir / TAKES_DIRNAME / take_id).resolve()
    if not folder.is_relative_to(job_dir.resolve()) or not is_finished(folder):
        return None
    return folder / TAKE_WAV_FILE


def take_lane_versions(job_dir: Path, names: Iterable[str]) -> list[str]:
    """Cache-key fragments for the take lanes in `names`. A take re-placed by a
    nudge is rewritten under the same name, and a track can switch its active
    take, so the take id, size and mtime pin the file the render read. Empty
    for a mix of stems only, which keeps its cache key unchanged."""
    out: list[str] = []
    for name in names:
        path = take_lane_path(job_dir, name) if is_take_lane(name) else None
        if path is None:
            continue
        st = path.stat()
        out.append(f"{name}={path.parent.name}@{st.st_size}:{st.st_mtime_ns}")
    return out


def limiter_filter(names: Iterable[str]) -> str:
    """The filter-chain suffix for the summed output: the export limiter when a
    take is in the mix, else nothing, so a stems-only export is byte-identical
    to what it was before takes existed."""
    return f",{EXPORT_LIMITER}" if has_take_lane(names) else ""
