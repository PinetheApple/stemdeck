"""Unknown ids are refused on PUT, as for setlists, but only filtered on GET: a
song can leave the registry between a client's GET and its PUT."""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.api.jobs import STEMS_FOLDER_MOVING_EDIT, _refuse_while_relocating
from app.core import library_order as store
from app.core.config import JOB_ID_RE, JOBS_DIR, LIBRARY_ORDER_MAX_SONGS
from app.core.registry import all_jobs as registry_all_jobs

logger = logging.getLogger("stemdeck.api")

router = APIRouter(tags=["library"])

_SAVE_FAILED = "failed to save library order"


class LibraryOrder(BaseModel):
    # Forbid, so a misspelt field is a 422 rather than a silent 200.
    model_config = ConfigDict(extra="forbid")

    song_ids: list[str] = Field(max_length=LIBRARY_ORDER_MAX_SONGS)

    @field_validator("song_ids")
    @classmethod
    def _song_ids(cls, value: list[str]) -> list[str]:
        if any(not JOB_ID_RE.match(song_id) for song_id in value):
            raise ValueError("song ids must be job ids")
        return list(dict.fromkeys(value))


def _require_known(song_ids: list[str]) -> None:
    known = registry_all_jobs()
    unknown = [song_id for song_id in song_ids if song_id not in known]
    if unknown:
        raise HTTPException(status_code=422, detail=f"unknown song ids: {', '.join(unknown)}")


def _served(song_ids: list[str]) -> dict[str, list[str]]:
    known = registry_all_jobs()
    return {"song_ids": [song_id for song_id in song_ids if song_id in known]}


@router.get("/order")
def get_library_order() -> dict[str, list[str]]:
    return _served(store.read_order(JOBS_DIR))


@router.put("/order")
def put_library_order(body: LibraryOrder) -> dict[str, list[str]]:
    _refuse_while_relocating(STEMS_FOLDER_MOVING_EDIT)
    _require_known(body.song_ids)
    try:
        saved = store.save_order(JOBS_DIR, body.song_ids)
    except OSError as exc:
        logger.exception(_SAVE_FAILED)
        raise HTTPException(status_code=500, detail=_SAVE_FAILED) from exc
    return _served(saved)
