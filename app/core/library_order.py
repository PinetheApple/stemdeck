"""My order: the user's drag order of the library's songs, kept on the server
so the desktop and the phone share it (#235).

It lives in library_order.json beside setlists.json in the jobs folder, as
`{"version": 1, "song_ids": [...]}`. Like the setlists file it is small and read
on every request, so the disk stays the only source of truth.

Writes are atomic (temp file, fsync, replace) under a lock held by this process,
so a crash never leaves a half-written order and two requests here never
interleave a read-modify-write. Another process writing the file is not guarded
against.
Validation of song ids against the registry is the API's job; this module only
stores what it is given. The server never sorts: songs missing from the list
are placed by the client.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from collections.abc import Collection
from pathlib import Path

from app.core.config import LIBRARY_ORDER_FILE, LIBRARY_ORDER_FILE_VERSION

logger = logging.getLogger("stemdeck.library_order")

_lock = threading.Lock()


def library_order_path(jobs_dir: Path) -> Path:
    return jobs_dir / LIBRARY_ORDER_FILE


def _read(jobs_dir: Path) -> list[str]:
    """The stored order, or [] when there is no file yet or it cannot be read."""
    path = library_order_path(jobs_dir)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning("could not read the library order from %s", path, exc_info=True)
        return []
    song_ids = data.get("song_ids") if isinstance(data, dict) else None
    if not isinstance(song_ids, list):
        return []
    return [song_id for song_id in song_ids if isinstance(song_id, str)]


def _write(jobs_dir: Path, song_ids: list[str]) -> None:
    """Raises OSError when the file cannot be written; the caller answers 500."""
    jobs_dir.mkdir(parents=True, exist_ok=True)
    path = library_order_path(jobs_dir)
    payload = json.dumps({"version": LIBRARY_ORDER_FILE_VERSION, "song_ids": song_ids}, indent=2)
    temp = jobs_dir / f".{LIBRARY_ORDER_FILE}.{uuid.uuid4().hex}.tmp"
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def song_ids(jobs_dir: Path) -> list[str]:
    with _lock:
        return _read(jobs_dir)


def replace(jobs_dir: Path, new_order: list[str]) -> list[str]:
    with _lock:
        _write(jobs_dir, list(new_order))
    return list(new_order)


def remove_songs(jobs_dir: Path, gone_ids: Collection[str]) -> None:
    """Take deleted songs out of the order, for the DELETE route.

    Best-effort: the songs are already gone, so a failed write logs rather than
    failing the delete; the API leaves unknown ids out of what it serves."""
    gone = set(gone_ids)
    with _lock:
        order = _read(jobs_dir)
        kept = [song_id for song_id in order if song_id not in gone]
        if len(kept) == len(order):
            return
        try:
            _write(jobs_dir, kept)
        except OSError:
            logger.warning(
                "could not remove %s from the library order",
                sorted(gone),
                exc_info=True,
            )


def replace_song(jobs_dir: Path, old_id: str, new_id: str) -> None:
    """Put a re-imported song in its old copy's place in the order.

    When the new copy is already listed the old one just goes, so no song is
    listed twice. Best-effort like remove_songs."""
    with _lock:
        order = _read(jobs_dir)
        if old_id not in order:
            return
        if new_id in order:
            order = [song_id for song_id in order if song_id != old_id]
        else:
            order = [new_id if song_id == old_id else song_id for song_id in order]
        try:
            _write(jobs_dir, order)
        except OSError:
            logger.warning(
                "could not put %s in place of %s in the library order",
                new_id,
                old_id,
                exc_info=True,
            )
