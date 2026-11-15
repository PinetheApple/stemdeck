"""Recorded takes as files in the song folder (layout: docs/takes.md).

The files are the record: nothing about takes is kept on the job, so every read
scans the folder and a restart loses nothing that reached the disk. Free of
FastAPI and ffmpeg, so auto-delete can ask has_takes() without the API layer.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from pathlib import Path
from typing import Any

from app.core.config import JOB_ID_RE
from app.core.song_folder import write_json_atomic
from app.core.takes_config import (
    AUDIO_PART_FILE,
    ID_HEX_BYTES,
    LOGGER_NAME,
    MS_PER_SEC,
    PARTS_FILE,
    RAW_WAV_FILE,
    SIDECAR_FILE,
    TAKE_ID_RE,
    TAKE_OPEN_STALE_SEC,
    TAKE_WAV_FILE,
    TAKES_DIRNAME,
    TRACK_ID_RE,
    TRACKS_FILE,
    TRACKS_FILE_VERSION,
)

logger = logging.getLogger(LOGGER_NAME)


def takes_root(jobs_dir: Path, job_id: str) -> Path | None:
    """jobs/<job_id>/takes, resolved, or None for a malformed id or a path
    that would leave the jobs directory. Does not check that it exists."""
    if not JOB_ID_RE.match(job_id):
        return None
    root = jobs_dir.resolve()
    path = (root / job_id / TAKES_DIRNAME).resolve()
    return path if path.is_relative_to(root) else None


def take_dir(jobs_dir: Path, job_id: str, take_id: str) -> Path | None:
    """The take's folder, resolved, or None when either id is malformed."""
    root = takes_root(jobs_dir, job_id)
    if root is None or not TAKE_ID_RE.match(take_id):
        return None
    return root / take_id


def new_id(prefix: str, existing: set[str]) -> str:
    while True:
        made = prefix + secrets.token_hex(ID_HEX_BYTES)
        if made not in existing:
            return made


def read_json(path: Path) -> dict[str, Any]:
    """The JSON object in `path`, or {} when it is missing or unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("could not read %s", path, exc_info=True)
        return {}
    return data if isinstance(data, dict) else {}


def take_folders(root: Path) -> list[Path]:
    """The take folders under a song's takes/, by id."""
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if TAKE_ID_RE.match(p.name) and p.is_dir())


def is_finished(folder: Path) -> bool:
    return (folder / SIDECAR_FILE).is_file() and (folder / TAKE_WAV_FILE).is_file()


def take_track_id(folder: Path) -> str | None:
    """The track a take belongs to: its sidecar's once finished, else the one
    it was opened on, so a broken parts.json never hides a finished take."""
    for name in (SIDECAR_FILE, PARTS_FILE):
        track_id = read_json(folder / name).get("track_id")
        if isinstance(track_id, str):
            return track_id
    return None


def takes_on_track(root: Path, track_id: str) -> list[Path]:
    return [f for f in take_folders(root) if take_track_id(f) == track_id]


def _holds_recording(folder: Path) -> bool:
    if (folder / SIDECAR_FILE).is_file() or (folder / RAW_WAV_FILE).is_file():
        return True
    part = folder / AUDIO_PART_FILE
    return part.is_file() and part.stat().st_size > 0


def has_takes(job_dir: Path) -> bool:
    """Whether the song holds a recording of the user's, finished or not.
    Auto-delete keeps such a song; an unreadable takes folder counts as one."""
    try:
        return any(_holds_recording(f) for f in take_folders(job_dir / TAKES_DIRNAME))
    except OSError:
        logger.warning("could not read the takes of %s", job_dir.name, exc_info=True)
        return True


def open_entry(folder: Path, state: dict[str, Any], now: float) -> dict[str, Any]:
    updated_at = float(state.get("updated_at") or state.get("created_at") or 0.0)
    return {
        "id": folder.name,
        "track_id": state.get("track_id"),
        "label": state.get("label"),
        "created_at": float(state.get("created_at") or 0.0),
        "updated_at": updated_at,
        "bytes": int((state.get("audio") or {}).get("bytes") or 0),
        "recoverable": now - updated_at > TAKE_OPEN_STALE_SEC,
    }


def scan_takes(job_dir: Path, now: float) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(sidecars of finished takes oldest first, open entries) from disk."""
    finished: list[dict[str, Any]] = []
    open_: list[dict[str, Any]] = []
    for folder in take_folders(job_dir / TAKES_DIRNAME):
        if is_finished(folder):
            sidecar = read_json(folder / SIDECAR_FILE)
            if sidecar:
                finished.append({**sidecar, "id": folder.name})
            continue
        state = read_json(folder / PARTS_FILE)
        if state and not state.get("finished"):
            open_.append(open_entry(folder, state, now))
    finished.sort(key=lambda s: float(s.get("created_at") or 0.0))
    return finished, open_


def placement_sec(sidecar: dict[str, Any]) -> float:
    """Song time of the first captured frame. A positive latency or nudge
    means the sound arrived late, so both are subtracted."""
    timeline = sidecar.get("timeline") or {}
    latency = sidecar.get("latency") or {}
    return (
        float(timeline.get("frame0_song_sec") or 0.0)
        - float(latency.get("round_trip_ms") or 0.0) / MS_PER_SEC
        - float(latency.get("user_nudge_ms") or 0.0) / MS_PER_SEC
    )


def take_entry(job_id: str, sidecar: dict[str, Any]) -> dict[str, Any]:
    """The lane record the studio reads for a finished take."""
    take_id = str(sidecar["id"])
    latency = sidecar.get("latency") or {}
    base = f"/api/jobs/{job_id}/takes/{take_id}"
    return {
        "id": take_id,
        "track_id": sidecar.get("track_id"),
        "label": sidecar.get("label"),
        "created_at": float(sidecar.get("created_at") or 0.0),
        "duration_sec": float(sidecar.get("duration_sec") or 0.0),
        "placement_sec": float(sidecar.get("placement_sec") or 0.0),
        "round_trip_ms": float(latency.get("round_trip_ms") or 0.0),
        "latency_source": latency.get("source"),
        "user_nudge_ms": float(latency.get("user_nudge_ms") or 0.0),
        "url": f"{base}/audio.wav",
        "peaks_url": f"{base}/peaks",
    }


def make_track(
    track_id: str,
    name: str,
    order: int,
    input_: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": track_id,
        "name": name,
        "order": order,
        "created_at": time.time(),
        "active_take_id": None,
        "input": input_,
    }


def read_tracks(job_dir: Path) -> list[dict[str, Any]]:
    """The track list in tracks.json, malformed entries dropped."""
    tracks = read_json(job_dir / TAKES_DIRNAME / TRACKS_FILE).get("tracks")
    if not isinstance(tracks, list):
        return []
    return [t for t in tracks if isinstance(t, dict) and TRACK_ID_RE.match(str(t.get("id")))]


def write_tracks(job_dir: Path, tracks: list[dict[str, Any]]) -> None:
    path = job_dir / TAKES_DIRNAME / TRACKS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, {"v": TRACKS_FILE_VERSION, "tracks": tracks})


def normalise_tracks(
    tracks: list[dict[str, Any]],
    finished: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Sorted by order and renumbered 0..n-1, each active_take_id a finished
    take of its own track, else that track's newest one, else None."""
    out = sorted(
        (dict(t) for t in tracks),
        key=lambda t: (t.get("order", 0), t.get("created_at", 0.0)),
    )
    for i, track in enumerate(out):
        track["order"] = i
        own = [s for s in finished if s.get("track_id") == track["id"]]
        if track.get("active_take_id") not in {s["id"] for s in own}:
            newest = max(own, key=lambda s: float(s.get("created_at") or 0.0), default=None)
            track["active_take_id"] = newest["id"] if newest else None
    return out
