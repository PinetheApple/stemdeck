"""Named setlists: ordered lists of library songs, kept on the server.

They live in setlists.json beside registry.json in the jobs folder, so a move
of the stems library (#354) carries them along with the songs they name. The
file is small and read on every request, which keeps the disk the only source
of truth: no cache to fall out of step with a hand edit.

Writes are atomic (temp file, fsync, replace) under a lock held by this process,
so a crash never leaves a half-written list and two requests here never
interleave a read-modify-write. Another process writing the file is not guarded
against.
Validation of song ids against the registry is the API's job; this module only
stores what it is given.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from collections.abc import Collection
from pathlib import Path
from typing import Any

from app.core.config import SETLIST_ID_HEX_CHARS, SETLISTS_FILE, SETLISTS_FILE_VERSION

logger = logging.getLogger("stemdeck.setlists")

_lock = threading.Lock()


def setlists_path(jobs_dir: Path) -> Path:
    return jobs_dir / SETLISTS_FILE


def _clean(record: Any) -> dict[str, Any] | None:
    """One stored setlist in the API's shape, or None if a damaged or
    hand-edited file put something else there."""
    if not isinstance(record, dict):
        return None
    setlist_id, name, song_ids = record.get("id"), record.get("name"), record.get("song_ids")
    if (
        not isinstance(setlist_id, str)
        or not isinstance(name, str)
        or not isinstance(song_ids, list)
    ):
        return None
    updated_at = record.get("updated_at")
    return {
        "id": setlist_id,
        "name": name,
        "song_ids": [song_id for song_id in song_ids if isinstance(song_id, str)],
        "updated_at": float(updated_at) if isinstance(updated_at, int | float) else 0.0,
    }


def _read_or_none(jobs_dir: Path) -> list[dict[str, Any]] | None:
    """The stored setlists, [] when there is no file yet, or None when the
    file exists but cannot be read as setlists."""
    path = setlists_path(jobs_dir)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning("could not read setlists from %s", path, exc_info=True)
        return None
    records = data.get("setlists") if isinstance(data, dict) else None
    if not isinstance(records, list):
        return None
    return [setlist for setlist in map(_clean, records) if setlist is not None]


def _read(jobs_dir: Path) -> list[dict[str, Any]]:
    return _read_or_none(jobs_dir) or []


def _write(jobs_dir: Path, setlists: list[dict[str, Any]]) -> None:
    """Raises OSError when the file cannot be written; the caller answers 500."""
    jobs_dir.mkdir(parents=True, exist_ok=True)
    path = setlists_path(jobs_dir)
    payload = json.dumps({"version": SETLISTS_FILE_VERSION, "setlists": setlists}, indent=2) + "\n"
    temp = jobs_dir / f".{SETLISTS_FILE}.{uuid.uuid4().hex}.tmp"
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def list_all(jobs_dir: Path) -> list[dict[str, Any]]:
    with _lock:
        return _read(jobs_dir)


def all_song_ids(jobs_dir: Path) -> set[str] | None:
    """Every song id in any setlist, or None when the file cannot be read, so a
    caller about to delete songs can tell "in no setlist" from "unknown"."""
    with _lock:
        setlists = _read_or_none(jobs_dir)
    if setlists is None:
        return None
    return {song_id for setlist in setlists for song_id in setlist["song_ids"]}


def create(jobs_dir: Path, name: str, song_ids: list[str]) -> dict[str, Any]:
    setlist = {
        "id": uuid.uuid4().hex[:SETLIST_ID_HEX_CHARS],
        "name": name,
        "song_ids": list(song_ids),
        "updated_at": time.time(),
    }
    with _lock:
        setlists = _read(jobs_dir)
        setlists.append(setlist)
        _write(jobs_dir, setlists)
    return setlist


def update(
    jobs_dir: Path,
    setlist_id: str,
    name: str | None = None,
    song_ids: list[str] | None = None,
) -> dict[str, Any] | None:
    """Change the given fields of one setlist. None when there is no such list."""
    with _lock:
        setlists = _read(jobs_dir)
        setlist = next((s for s in setlists if s["id"] == setlist_id), None)
        if setlist is None:
            return None
        if name is not None:
            setlist["name"] = name
        if song_ids is not None:
            setlist["song_ids"] = list(song_ids)
        setlist["updated_at"] = time.time()
        _write(jobs_dir, setlists)
    return setlist


def delete(jobs_dir: Path, setlist_id: str) -> bool:
    with _lock:
        setlists = _read(jobs_dir)
        kept = [s for s in setlists if s["id"] != setlist_id]
        if len(kept) == len(setlists):
            return False
        _write(jobs_dir, kept)
    return True


def remove_songs(jobs_dir: Path, song_ids: Collection[str]) -> None:
    """Take deleted songs out of every setlist that names them, for the
    DELETE route.

    Best-effort: the songs are already gone, so a failed write logs rather than
    failing the delete; the API leaves unknown ids out of what it serves."""
    gone = set(song_ids)
    if not gone:
        return
    with _lock:
        setlists = _read(jobs_dir)
        changed = False
        for setlist in setlists:
            kept = [s for s in setlist["song_ids"] if s not in gone]
            if len(kept) != len(setlist["song_ids"]):
                setlist["song_ids"] = kept
                setlist["updated_at"] = time.time()
                changed = True
        if not changed:
            return
        try:
            _write(jobs_dir, setlists)
        except OSError:
            logger.warning("could not remove %s from setlists", sorted(gone), exc_info=True)
