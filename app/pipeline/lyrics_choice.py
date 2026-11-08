"""The track's lyrics as the user decided them, kept with the song: a version
they picked, or their removal.

A picked version becomes the job's lyrics.json, marked CHOSEN; a removal
deletes it and leaves LYRICS_REMOVED_FILE in its place. Every reader of
lyrics.json, every device and song bundle, gets the user's decision, and
nothing found later undoes it (keep_answer and lyrics_settled honour both).

A version kept with ``picked`` false, such as a file's embedded lyrics the
page keeps on its own, is no decision: it is written without CHOSEN, as
lyrics the server finds are, and yields to any decision of the user's.

A browser carries over what it kept once (``carry_over``). The server wins
then whenever it holds a decision of the user's: their own words, a pick,
timing or alignment they gave, or a removal. Such a decision was made on
purpose, maybe after the browser's entry, while lyrics merely found were not;
so the upload never throws away the user's work, and a second browser's
upload, or the same one repeated, changes nothing.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from app.core.config import LYRICS_OTHERS_MAX
from app.core.models import Job, _set
from app.pipeline.lyrics_lookup import (
    _OFFSET_LOCK,
    CHOSEN,
    TIMING_EXACT,
    TIMING_UNVERIFIED,
    USER_SOURCE,
    _clean_version,
    _write_json_atomic,
    clean_lyrics,
    lyrics_path,
    lyrics_removed,
    lyrics_worked_on,
    original_path,
    read_candidates,
    read_lyrics,
    removed_path,
    same_recording,
    write_lyrics,
)

logger = logging.getLogger("stemdeck.lyrics")

# What the server works out itself, whatever the version sent says.
_NOT_TAKEN = frozenset(("others", "timing", CHOSEN, "untimed_lines", "has_original"))


class NotAVersion(ValueError):
    """A pick that is not a version of lyrics the server can keep."""


class UsersOwnWords(ValueError):
    """A pick over the user's own words, which only going back to the
    original (restore_lyrics) puts aside."""


def user_decided(job_dir: Path, entry: dict[str, Any] | None) -> bool:
    """Whether the job's lyrics (``entry``, as read) or their absence are the
    user's doing, which a carried-over choice must leave as they are."""
    if lyrics_removed(job_dir):
        return True
    return entry is not None and (entry["source"] == USER_SOURCE or lyrics_worked_on(entry))


def _as_version(version: Any) -> dict[str, Any]:
    if not isinstance(version, dict) or version.get("source") == USER_SOURCE:
        raise NotAVersion("not a version of lyrics")
    entry = clean_lyrics({k: v for k, v in version.items() if k not in _NOT_TAKEN} | {"v": 1})
    if entry is None:
        raise NotAVersion("not a version of lyrics")
    return entry


def _timing(version: dict[str, Any], job: Job) -> str:
    """TIMING_EXACT unless the version is synced and its length and the
    track's are known and are not one recording's."""
    track = job.duration_sec or 0
    unknown = not (version["synced"] and track and version["duration"])
    return TIMING_EXACT if unknown or same_recording(version, track) else TIMING_UNVERIFIED


def _others_beside(
    kept: dict[str, Any],
    current: dict[str, Any] | None,
    job_dir: Path,
) -> list[dict[str, Any]]:
    """The LRCLIB versions still to offer: what was shown, what it offered and
    the candidates, once each, without ``kept``."""
    pool = [current, *current["others"]] if current else []
    found = read_candidates(job_dir)
    pool += found["others"] if found else []
    seen = {kept["lrclib_id"]}
    others = []
    for version in filter(None, map(_clean_version, pool)):
        if version["lrclib_id"] and version["lrclib_id"] not in seen:
            seen.add(version["lrclib_id"])
            others.append(version)
    return others[:LYRICS_OTHERS_MAX]


def choose_lyrics(
    job: Job,
    job_dir: Path,
    version: Any,
    *,
    picked: bool = True,
    carry_over: bool = False,
) -> bool:
    """Keep ``version`` (a version in lyrics.json's shape, without ``v``) as
    the job's lyrics: the user's pick, or with ``picked`` false lyrics kept as
    found ones are. Unless it is a live pick, nothing changes when the user
    already decided on the server. False when it could not be written.
    Raises NotAVersion, and UsersOwnWords for a live pick over the user's
    own words."""
    entry = _as_version(version)
    with _OFFSET_LOCK:
        current = read_lyrics(job_dir)
        if (carry_over or not picked) and user_decided(job_dir, current):
            return True
        if current is not None and current["source"] == USER_SOURCE:
            raise UsersOwnWords("lyrics are the user's own")
        entry |= {"timing": _timing(entry, job), "others": _others_beside(entry, current, job_dir)}
        if picked:
            entry[CHOSEN] = True
        return write_lyrics(job, job_dir, entry)


def remove_lyrics(job: Job, job_dir: Path, *, carry_over: bool = False) -> bool:
    """Remove the job's lyrics, whatever they are, and what the user's own
    replaced, and keep that they were removed. With ``carry_over``, nothing
    changes when the user already decided on the server. False, logged, when
    it could not be done."""
    with _OFFSET_LOCK:
        if carry_over and user_decided(job_dir, read_lyrics(job_dir)):
            return True
        try:
            _write_json_atomic(removed_path(job_dir), {"v": 1, "removed_at": time.time()})
            lyrics_path(job_dir).unlink(missing_ok=True)
            original_path(job_dir).unlink(missing_ok=True)
        except OSError:
            logger.warning("could not remove lyrics for job %s", job.id, exc_info=True)
            return False
    _set(job, has_lyrics=False)
    return True
