"""Recorded takes: the files a take is made of, and what they say (#98).

A song's takes live in its folder, beside the stems and never in them:

    jobs/<job_id>/takes/
        tracks.json              {"v": 1, "tracks": [...]}, the recording tracks
        <take_id>/
            parts.json           upload state and the start sidecar, while open
            audio.part           float32 interleaved PCM received so far
            audio.raw.wav        exactly what was captured, built at finish
            audio.wav            the playable lane, in the stems' format
            peaks.json           {"<take_id>": [[min, max], ...]}
            take.json            the sidecar: timing, latency, capture

The files are the record. Nothing about takes is kept on the job: every read
scans the folder, so a restart, a crash or a lost registry costs nothing that
reached the disk. A take is finished once it has take.json and audio.wav, and
open while it has parts.json without "finished".

Takes stay out of stems/ on purpose: the stem storage stage, the song bundle
(which ships stems/peaks.json verbatim) and every stem reader never see them.
They live and die with the song folder: the Trash keeps them, delete removes
them, a library move carries them.

Kept free of FastAPI and ffmpeg, so auto-delete can ask has_takes() without
importing the API layer.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import time
import uuid
from pathlib import Path
from typing import Any

from app.core.config import JOB_ID_RE
from app.core.takes_config import (
    AUDIO_PART_FILE,
    ID_HEX_BYTES,
    PARTS_FILE,
    RAW_WAV_FILE,
    SIDECAR_FILE,
    TAKE_ID_RE,
    TAKE_OPEN_STALE_SEC,
    TAKE_WAV_FILE,
    TAKES_DIRNAME,
    TRACK_ID_RE,
    TRACK_KIND_AUDIO,
    TRACKS_FILE,
    TRACKS_FILE_VERSION,
)

logger = logging.getLogger("stemdeck.takes")


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


def write_json_atomic(path: Path, data: Any) -> None:
    """Temp beside it, then os.replace: a reader sees the old file or the new."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


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


def _take_folders(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted(p for p in root.iterdir() if TAKE_ID_RE.match(p.name) and p.is_dir())


def is_finished(folder: Path) -> bool:
    return (folder / SIDECAR_FILE).is_file() and (folder / TAKE_WAV_FILE).is_file()


def _holds_recording(folder: Path) -> bool:
    if is_finished(folder) or (folder / RAW_WAV_FILE).is_file():
        return True
    part = folder / AUDIO_PART_FILE
    return part.is_file() and part.stat().st_size > 0


def has_takes(job_dir: Path) -> bool:
    """Whether the song holds a recording of the user's: a finished take, an
    open one that received audio, or one cut off mid-finish. Auto-delete keeps
    such a song. A takes folder that cannot be read counts as holding one: a
    folder that cannot be read is never removed."""
    try:
        return any(_holds_recording(f) for f in _take_folders(job_dir / TAKES_DIRNAME))
    except OSError:
        logger.warning("could not read the takes of %s", job_dir.name, exc_info=True)
        return True


def open_entry(folder: Path, state: dict[str, Any], now: float) -> dict[str, Any]:
    """What GET /takes lists for a take still being recorded (or orphaned)."""
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
    for folder in _take_folders(job_dir / TAKES_DIRNAME):
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
    """The song time of the take's first captured frame, the only formula:
    the uncompensated song time minus the round trip minus the user's nudge.
    Positive latency or nudge means the sound arrived late."""
    timeline = sidecar.get("timeline") or {}
    latency = sidecar.get("latency") or {}
    return (
        float(timeline.get("frame0_song_sec") or 0.0)
        - float(latency.get("round_trip_ms") or 0.0) / 1000.0
        - float(latency.get("user_nudge_ms") or 0.0) / 1000.0
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
        "has_camera": False,
        "camera_url": None,
    }


# ---------------------------------------------------------------------------
# Tracks


def make_track(
    track_id: str,
    name: str,
    order: int,
    input_: dict[str, Any] | None = None,
    kind: str = TRACK_KIND_AUDIO,
) -> dict[str, Any]:
    return {
        "id": track_id,
        "name": name,
        "kind": kind,
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
    write_json_atomic(
        job_dir / TAKES_DIRNAME / TRACKS_FILE,
        {"v": TRACKS_FILE_VERSION, "tracks": tracks},
    )


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
