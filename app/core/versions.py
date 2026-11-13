"""Versions of a song: named choices of the song's stems, kept as settings
over its one set of stem files. A song with none recorded reads as one
implicit default."""

from __future__ import annotations

import logging
import math
import re
import time
import uuid
from typing import Any

from app.core.config import MAX_VERSIONS_PER_SONG, STEM_NAMES, VERSION_NAME_MAX_CHARS

logger = logging.getLogger("stemdeck.versions")

DEFAULT_VERSION_ID = "main"
# Short, lowercase, safe in a URL path and a store key.
VERSION_ID_RE = re.compile(r"^[a-z0-9]{1,16}$")
_NEW_ID_HEX_CHARS = 8


def is_version_id(value: Any) -> bool:
    return isinstance(value, str) and VERSION_ID_RE.match(value) is not None


def clean_stems(value: Any) -> list[str]:
    """The base stems named in `value`, in STEM_NAMES order, each once.
    Unknown names are dropped; empty when none is left."""
    if not isinstance(value, list):
        return []
    wanted = {name for name in value if isinstance(name, str)}
    return [name for name in STEM_NAMES if name in wanted]


def _clean_name(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return value.strip()[:VERSION_NAME_MAX_CHARS] or None


def _clean_time(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value) if math.isfinite(value) else 0.0


def _clean_one(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not is_version_id(raw.get("id")):
        return None
    return {
        "id": raw["id"],
        "name": _clean_name(raw.get("name")),
        "stems": clean_stems(raw.get("stems")) or list(STEM_NAMES),
        "created_at": _clean_time(raw.get("created_at")),
    }


def clean_versions(value: Any) -> list[dict[str, Any]] | None:
    """The versions recorded on a song, made safe, or None when it has none
    recorded and the implicit default applies. Never raises."""
    if value is None:
        return None
    if not isinstance(value, list):
        logger.warning("dropping a versions value that is not a list")
        return None
    kept: list[dict[str, Any]] = []
    for raw in value:
        version = _clean_one(raw)
        if version is None or any(v["id"] == version["id"] for v in kept):
            logger.warning("dropping an unreadable version entry")
            continue
        kept.append(version)
    return kept[:MAX_VERSIONS_PER_SONG] or None


def versions_of(job: Any) -> list[dict[str, Any]]:
    """Every version of `job`, never empty: the recorded ones, or the implicit
    default when none is recorded. Copies, safe to change."""
    if job.versions:
        return [dict(v, stems=list(v["stems"])) for v in job.versions]
    return [
        {
            "id": DEFAULT_VERSION_ID,
            "name": None,
            "stems": clean_stems(job.selected_stems) or list(STEM_NAMES),
            "created_at": _clean_time(job.created_at),
        }
    ]


def open_version_of(job: Any, versions: list[dict[str, Any]]) -> str:
    """The version that opens with the song: the one opened last, or the
    first when that one is gone."""
    ids = [v["id"] for v in versions]
    return job.open_version if job.open_version in ids else ids[0]


def find_version(versions: list[dict[str, Any]], version_id: str) -> dict[str, Any] | None:
    return next((v for v in versions if v["id"] == version_id), None)


def find_by_stems(versions: list[dict[str, Any]], stems: list[str]) -> dict[str, Any] | None:
    return next((v for v in versions if set(v["stems"]) == set(stems)), None)


def new_version(versions: list[dict[str, Any]], name: str, stems: list[str]) -> dict[str, Any]:
    """A version to add to `versions`, with an id none of them has."""
    taken = {v["id"] for v in versions} | {DEFAULT_VERSION_ID}
    version_id = uuid.uuid4().hex[:_NEW_ID_HEX_CHARS]
    while version_id in taken:
        version_id = uuid.uuid4().hex[:_NEW_ID_HEX_CHARS]
    return {"id": version_id, "name": name, "stems": stems, "created_at": time.time()}
