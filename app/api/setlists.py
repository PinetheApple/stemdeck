"""Setlists: named, ordered lists of library songs, shown in the library pane.

Stored by app/core/setlists.py. Every song id must name a job the registry
knows when it is saved, and appear once per list. Deleting a song and the
retention sweep remove it from every list (delete_job in app/api/jobs.py,
collect.sweep_old_jobs); anything else that drops a job, such as a folder
removed by hand, is covered by serving only ids the registry still knows.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core import setlists as store
from app.core.config import (
    JOB_ID_RE,
    JOBS_DIR,
    SETLIST_ID_HEX_CHARS,
    SETLIST_MAX_SONGS,
    SETLIST_NAME_MAX_CHARS,
)
from app.core.models import checked_name
from app.core.registry import all_jobs as registry_all_jobs

logger = logging.getLogger("stemdeck.api")

router = APIRouter(tags=["setlists"])

_SETLIST_ID_RE = re.compile(rf"^[0-9a-f]{{{SETLIST_ID_HEX_CHARS}}}$")


def _check_song_ids(value: list[str]) -> list[str]:
    if any(not JOB_ID_RE.match(song_id) for song_id in value):
        raise ValueError("song ids must be job ids")
    if len(set(value)) != len(value):
        raise ValueError("a song can appear only once in a setlist")
    return value


class SetlistCreate(BaseModel):
    # Forbid, so a misspelt field is a 422 rather than a silent 200.
    model_config = ConfigDict(extra="forbid")

    name: str
    song_ids: list[str] = Field(default_factory=list, max_length=SETLIST_MAX_SONGS)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        return checked_name(value, SETLIST_NAME_MAX_CHARS)

    @field_validator("song_ids")
    @classmethod
    def _song_ids(cls, value: list[str]) -> list[str]:
        return _check_song_ids(value)


class SetlistUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    song_ids: list[str] | None = Field(default=None, max_length=SETLIST_MAX_SONGS)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str | None) -> str:
        if value is None:
            raise ValueError("name cannot be null")
        return checked_name(value, SETLIST_NAME_MAX_CHARS)

    @field_validator("song_ids")
    @classmethod
    def _song_ids(cls, value: list[str] | None) -> list[str]:
        if value is None:
            raise ValueError("song_ids cannot be null")
        return _check_song_ids(value)


def _require_known(song_ids: list[str]) -> None:
    known = registry_all_jobs()
    unknown = [song_id for song_id in song_ids if song_id not in known]
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown song ids: {', '.join(unknown)}")


def _served(setlist: dict[str, Any], known: dict[str, Any]) -> dict[str, Any]:
    return {**setlist, "song_ids": [s for s in setlist["song_ids"] if s in known]}


def _save_failed(action: str) -> HTTPException:
    logger.exception("failed to %s setlist", action)
    return HTTPException(status_code=500, detail=f"failed to {action} setlist")


@router.get("")
def list_setlists() -> list[dict[str, Any]]:
    """Every setlist, oldest first."""
    known = registry_all_jobs()
    return [_served(setlist, known) for setlist in store.list_all(JOBS_DIR)]


@router.post("", status_code=201)
def create_setlist(body: SetlistCreate) -> dict[str, Any]:
    _require_known(body.song_ids)
    try:
        return store.create(JOBS_DIR, body.name, body.song_ids)
    except OSError as exc:
        raise _save_failed("create") from exc


@router.patch("/{setlist_id}")
def update_setlist(setlist_id: str, body: SetlistUpdate) -> dict[str, Any]:
    if not _SETLIST_ID_RE.match(setlist_id):
        raise HTTPException(status_code=404, detail="setlist not found")
    if not body.model_fields_set:
        raise HTTPException(status_code=422, detail="nothing to change")
    if body.song_ids is not None:
        _require_known(body.song_ids)
    try:
        setlist = store.update(JOBS_DIR, setlist_id, name=body.name, song_ids=body.song_ids)
    except OSError as exc:
        raise _save_failed("update") from exc
    if setlist is None:
        raise HTTPException(status_code=404, detail="setlist not found")
    return _served(setlist, registry_all_jobs())


@router.delete("/{setlist_id}")
def delete_setlist(setlist_id: str) -> dict[str, str]:
    if not _SETLIST_ID_RE.match(setlist_id):
        raise HTTPException(status_code=404, detail="setlist not found")
    try:
        deleted = store.delete(JOBS_DIR, setlist_id)
    except OSError as exc:
        raise _save_failed("delete") from exc
    if not deleted:
        raise HTTPException(status_code=404, detail="setlist not found")
    return {"id": setlist_id, "status": "deleted"}
