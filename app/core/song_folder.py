"""What a song's folder keeps so restore() can rebuild it without registry.json:
the fields only the registry held, the completion marker, the add time."""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import uuid
from pathlib import Path
from typing import Any

from app.core.config import JOB_ID_RE, STEM_NAMES, UPLOAD_EXTS
from app.core.models import Job

logger = logging.getLogger("stemdeck.registry")

# The last file a separation writes into stems/ (mark_stems_complete): a folder
# without it was cut off part way (upstream PR 901).
STEMS_COMPLETE = ".complete"

# Where a failed job's evidence is kept, under the jobs folder.
FAILED_DIR_NAME = "failed"

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
    "source_name",
    "created_at",
)


def saved_fields(job: Job) -> dict[str, Any]:
    """The job's SAVED_FIELDS, as metadata.json keeps them."""
    return {name: getattr(job, name) for name in SAVED_FIELDS}


def is_non_negative_number(value: object) -> bool:
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
        return value is None or is_non_negative_number(value), value
    if name == "created_at":
        return is_non_negative_number(value), value
    if name == "selected_stems":
        stems = _clean_stems(value)
        return stems is not None, stems
    if name in ("source_url", "source_name"):
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


def job_dirs(folder: Path) -> list[Path]:
    """The job folders directly inside `folder` (the jobs folder, or its
    failed/ quarantine): a job id for a name, and a real directory. The jobs
    folder can be shared with other things, so nothing else in it is a job."""
    if not folder.is_dir():
        return []
    return [
        d for d in folder.iterdir() if JOB_ID_RE.match(d.name) and d.is_dir() and is_real_entry(d)
    ]


# What StemDeck writes into every job folder it makes: one of these is there.
_JOB_ENTRIES = ("stems", "metadata.json")
_SOURCE_GLOB = "source.*"


def holds_job_files(job_dir: Path) -> bool:
    """Whether a job-id folder holds something StemDeck writes into a job. The
    name alone does not make it ours: twelve hex characters is also a Docker
    container's short id. A folder that cannot be read is not ours to remove."""
    try:
        return any((job_dir / name).exists() for name in _JOB_ENTRIES) or any(
            job_dir.glob(_SOURCE_GLOB)
        )
    except OSError:
        return False


def quarantine_dirs(jobs_dir: Path) -> list[Path]:
    """The job folders in failed/ that are StemDeck's quarantine: the runner
    writes error.txt into each before moving it there. Empty when failed/ is a
    link, or holds only someone else's folders."""
    failed_root = jobs_dir / FAILED_DIR_NAME
    if not failed_root.exists() or not is_real_entry(failed_root):
        return []
    return [d for d in job_dirs(failed_root) if (d / "error.txt").is_file()]


# The files reset removes beside the job folders: the registry, its temp and
# set-aside copies (persist, keep_bad_records), the setlists and the desktop
# shell's store with the copies its save keeps, each with the temp name of an
# atomic write. A copy left behind would bring the old library back.
_OWN_FILE_RE = re.compile(
    r"(registry\.json(\.bad-[\w-]+)?|user-data\.json(\.(bak|tmp|corrupt-[0-9]+))?"
    r"|setlists\.json)\Z"
    r"|\.(registry|registry\.json|setlists\.json)\.[0-9a-f]{32}\.tmp\Z"
)


def own_entries(jobs_dir: Path, known: set[str]) -> list[Path]:
    """What reset removes: job folders the registry knows or that hold job
    files, StemDeck's quarantined failures, and its own files. The jobs folder
    can be shared with other things (upstream PR 886), so nothing else, and
    nothing behind a link."""
    targets = [d for d in job_dirs(jobs_dir) if d.name in known or holds_job_files(d)]
    targets += quarantine_dirs(jobs_dir)
    targets += [
        f
        for f in jobs_dir.iterdir()
        if _OWN_FILE_RE.match(f.name) and f.is_file() and is_real_entry(f)
    ]
    return targets


def remove_empty_failed_root(jobs_dir: Path, failed: list[str]) -> None:
    """failed/ goes only once empty: anything still in it is not ours."""
    failed_root = jobs_dir / FAILED_DIR_NAME
    if not failed_root.is_dir() or not is_real_entry(failed_root) or any(failed_root.iterdir()):
        return
    try:
        failed_root.rmdir()
    except OSError:
        logger.warning("reset: could not remove %s", failed_root, exc_info=True)
        failed.append(failed_root.name)


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
    """Record that the separation wrote every stem it makes: a kill before this
    leaves no marker. Stems are fsynced first so the marker never outlives them."""
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


def update_metadata(job_dir: Path, fields: dict[str, Any]) -> bool:
    """Put `fields` into the song's metadata.json, changing nothing else in it.
    False when the song has no usable metadata.json."""
    meta_path = job_dir / "metadata.json"
    with metadata_lock:
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if not isinstance(meta, dict):
                return False
            meta.update(fields)
            write_json_atomic(meta_path, meta)
        except FileNotFoundError:
            return False
        except (OSError, RecursionError, ValueError):
            logger.warning("could not update metadata.json in %s", job_dir.name, exc_info=True)
            return False
    return True


def copy_saved_fields(job: Job, job_dir: Path) -> bool:
    """Put the job's SAVED_FIELDS into its metadata.json. Read under the lock,
    so of two quick changes the later one is what stays."""
    with metadata_lock:
        return update_metadata(job_dir, saved_fields(job))


def read_metadata(meta_path: Path) -> Any:
    """metadata.json as parsed, {} when there is none, or None when it cannot
    be read as JSON."""
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, RecursionError, ValueError):
        logger.warning("could not read %s", meta_path, exc_info=True)
        return None


def is_started_only(meta: Any) -> bool:
    """A metadata.json that only holds what keep_added_time starts it with: a
    finished run writes the title among the rest (upstream PR 1005)."""
    return isinstance(meta, dict) and "created_at" in meta and "title" not in meta


def keep_added_time(job: Job, job_dir: Path) -> None:
    """Start the song's metadata.json with the time it was added, when its
    folder has none yet, so a song rebuilt from its folder keeps its place in
    the library. The folder's own time moves with every file written into it.
    Never fails the caller: without it, the rebuild takes the folder's time."""
    meta_path = job_dir / "metadata.json"
    with metadata_lock:
        try:
            if meta_path.exists():
                return
            write_json_atomic(meta_path, {"created_at": job.created_at})
        except OSError:
            logger.warning("could not write the add time of %s", job.id, exc_info=True)
