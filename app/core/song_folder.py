"""What a song's folder keeps so the library can be rebuilt without registry.json.

registry.json is the library's record, and restore() (app/core/registry.py)
rebuilds a song from its folder when the registry has no entry for it: the
file was lost, cut off or set aside as corrupt. The folder then has to say
everything the song needs. Stems, peaks and lyrics are files already, and
metadata.json carries what the analysis found. This module covers the rest:

- SAVED_FIELDS: what the user chose for a song, or its import recorded, that
  nothing in the folder can be derived from (the favourite, the Trash, the stem
  selection, the source, the date added). metadata.json keeps a copy, written
  when the song finishes and by every request that changes one after that
  (upstream PR 883). Read back through saved_from_meta, which checks each value
  the way a registry record is checked: the file is on disk, anything can be in
  it.
"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import uuid
from pathlib import Path
from typing import Any

from app.core.config import STEM_NAMES, UPLOAD_EXTS
from app.core.models import Job

logger = logging.getLogger("stemdeck.registry")

# The last file a separation writes into stems/ (mark_stems_complete): a folder
# without it was cut off part way (upstream PR 901).
STEMS_COMPLETE = ".complete"

# Held by every read-modify-write of a song's metadata.json (app/api/jobs.py and
# the copy restore() makes), so neither replaces the other's change. Reentrant:
# a caller that reads the job's fields under it then writes through a helper
# that takes it too.
metadata_lock = threading.RLock()

SAVED_FIELDS = (
    "favorite",
    "trashed_at",
    "selected_stems",
    "source_url",
    "source_format",
    "created_at",
)


def saved_fields(job: Job) -> dict[str, Any]:
    """The job's SAVED_FIELDS, as metadata.json keeps them."""
    return {name: getattr(job, name) for name in SAVED_FIELDS}


def _is_time(value: object) -> bool:
    """A real, finite, non-negative number: no song was added before 1970,
    and NaN or infinity fails every JSON response the library sends."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value) and value >= 0


def _clean_stems(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    stems = [name for name in STEM_NAMES if name in value]
    return stems or None


def _clean_value(name: str, value: object) -> tuple[bool, object]:
    """Whether metadata.json's `value` for SAVED_FIELDS `name` may be loaded,
    and the value to load."""
    if name == "favorite":
        return value is None or isinstance(value, bool), value
    if name == "trashed_at":
        return value is None or _is_time(value), value
    if name == "created_at":
        return _is_time(value), value
    if name == "selected_stems":
        stems = _clean_stems(value)
        return stems is not None, stems
    if name == "source_url":
        return value is None or isinstance(value, str), value
    # source_format: drawn as the upload's format icon, so only a known one.
    return value is None or (isinstance(value, str) and f".{value}" in UPLOAD_EXTS), value


def saved_from_meta(meta: dict, names: tuple[str, ...] = SAVED_FIELDS) -> dict[str, Any]:
    """The `names` metadata.json holds with a value that may be loaded. A bad
    one is left out, so the job keeps what its folder gives."""
    found: dict[str, Any] = {}
    for name in names:
        if name not in meta:
            continue
        ok, value = _clean_value(name, meta[name])
        if ok:
            found[name] = value
    return found


def is_real_entry(entry: Path) -> bool:
    """Whether `entry` is itself in its folder, not a link or a Windows
    junction to somewhere else. Removing or writing what is found by walking
    through one reaches whatever it points at."""
    return entry.resolve() == entry.parent.resolve() / entry.name


def write_text_atomic(path: Path, text: str) -> None:
    """Durably replace a file without exposing a partial write."""
    temp = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temp.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def write_json_atomic(path: Path, data: dict) -> None:
    """Durably replace a JSON file without exposing a partial write."""
    write_text_atomic(path, json.dumps(data, indent=2) + "\n")


def _fsync_dir(folder: Path) -> None:
    # Windows cannot open a folder to fsync it; NTFS journals the rename.
    if os.name == "nt":
        return
    fd = os.open(folder, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def mark_stems_complete(job_dir: Path) -> None:
    """Record that a separation wrote every stem file it makes in stems/.
    Called last, so a kill at any point before leaves a folder without the
    marker. The stems and the folder reach the disk before the marker does: a
    power cut could otherwise keep the marker and lose a stem's bytes.
    Raises OSError."""
    stems_dir = job_dir / "stems"
    for path in sorted(stems_dir.glob("*.wav")):
        # Opened for writing: Windows only flushes a handle that can write.
        with open(path, "r+b") as handle:
            os.fsync(handle.fileno())
    _fsync_dir(stems_dir)
    write_text_atomic(stems_dir / STEMS_COMPLETE, "")


def backfill_stems_complete(job_dir: Path) -> None:
    """The marker for a song made before it, which the registry holds as done,
    so a registry lost later still brings it back. Never fatal: restore()
    runs at import time."""
    stems_dir = job_dir / "stems"
    try:
        if (stems_dir / STEMS_COMPLETE).is_file() or not any(stems_dir.glob("*.wav")):
            return
        write_text_atomic(stems_dir / STEMS_COMPLETE, "")
    except OSError:
        logger.warning("could not mark the stems of %s complete", job_dir.name, exc_info=True)


def copy_saved_fields(job: Job, job_dir: Path) -> bool:
    """Put the job's SAVED_FIELDS into its metadata.json, changing nothing
    else in it. False when the song has no usable metadata.json."""
    meta_path = job_dir / "metadata.json"
    with metadata_lock:
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if not isinstance(meta, dict):
                return False
            meta.update(saved_fields(job))
            write_json_atomic(meta_path, meta)
        except FileNotFoundError:
            return False
        except (OSError, RecursionError, ValueError):
            logger.warning("could not copy saved fields into %s", job_dir.name, exc_info=True)
            return False
    return True
