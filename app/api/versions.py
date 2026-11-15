"""The routes that list, open, rename, save, extract and delete a song's
versions. Every GET, and opening the open version, writes nothing.

Extracting stems whose files the song is missing separates its kept audio,
or a link song's audio fetched again, in the background
(app/pipeline/extract_stems.py), followed and cancelled through
.../versions/extract."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from app.api.jobs import (
    RESTORE_FROM_TRASH_FIRST,
    STEMS_FOLDER_MOVING_IMPORT,
    _retained_source,
    _terminate_worker,
)
from app.core.config import (
    JOB_ID_RE,
    JOBS_DIR,
    MAX_VERSIONS_PER_SONG,
    STEM_NAMES,
    VERSION_NAME_MAX_CHARS,
)
from app.core.models import STATUS_DONE, Job, _set, checked_name
from app.core.registry import get as registry_get
from app.core.registry import persist as registry_persist
from app.core.song_folder import copy_saved_fields, metadata_lock
from app.core.stems_location import is_relocating
from app.core.versions import (
    clean_stems,
    find_by_stems,
    find_version,
    new_version,
    open_version_of,
    versions_of,
)
from app.pipeline.extract_stems import (
    EXTRACT_FAILED_TOO_MANY_VERSIONS,
    EXTRACT_RUNS,
    ExtractFailed,
    cancel_extract,
    claim_extract,
    extract_view,
    link_of,
    missing_stems,
    run_extract,
)
from app.pipeline.runs import start_run_task

router = APIRouter(tags=["jobs"])

JOB_NOT_FOUND = "job not found"
VERSION_NOT_FOUND = "version not found"
SONG_NOT_READY = "the song is not ready"
NO_KNOWN_STEM = "choose at least one known stem"
TOO_MANY_VERSIONS = "this song has too many versions"
STEMS_ALREADY_IN_VERSION = "those stems are already in this version"
SOURCE_GONE = "this song's original audio is not kept; import it again to get these stems"
EXTRACT_RUNNING = "more stems are already being extracted for this song"
LAST_VERSION_KEPT = "a song keeps at least one version; move it to the Trash instead"


class VersionNameBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str

    @field_validator("name")
    @classmethod
    def _check_name(cls, value: str) -> str:
        return checked_name(value, VERSION_NAME_MAX_CHARS)


class VersionStemsBody(VersionNameBody):
    stems: list[str] = Field(max_length=len(STEM_NAMES))


class NewVersionBody(VersionStemsBody):
    open: StrictBool = False


class ExtractBody(VersionStemsBody):
    source: str = Field(alias="from")


def _song(job_id: str) -> Job:
    job = registry_get(job_id) if JOB_ID_RE.match(job_id) else None
    if job is None:
        raise HTTPException(status_code=404, detail=JOB_NOT_FOUND)
    return job


def _writable_song(job_id: str) -> Job:
    job = _song(job_id)
    if job.trashed_at is not None:
        raise HTTPException(status_code=409, detail=RESTORE_FROM_TRASH_FIRST)
    if job.status != STATUS_DONE:
        raise HTTPException(status_code=409, detail=SONG_NOT_READY)
    return job


def _version(versions: list[dict[str, Any]], version_id: str) -> dict[str, Any]:
    version = find_version(versions, version_id)
    if version is None:
        raise HTTPException(status_code=404, detail=VERSION_NOT_FOUND)
    return version


def _known_stems(value: list[str]) -> list[str]:
    stems = clean_stems(value)
    if not stems:
        raise HTTPException(status_code=422, detail=NO_KNOWN_STEM)
    return stems


def _has_room(versions: list[dict[str, Any]]) -> bool:
    return len(versions) < MAX_VERSIONS_PER_SONG


def _room_for_one_more(versions: list[dict[str, Any]]) -> None:
    if not _has_room(versions):
        raise HTTPException(status_code=409, detail=TOO_MANY_VERSIONS)


def _payload(job: Job) -> dict[str, Any]:
    versions = versions_of(job)
    return {
        "job_id": job.id,
        "versions": versions,
        "open_version": open_version_of(job, versions),
    }


def _save(
    job: Job,
    versions: list[dict[str, Any]] | None,
    open_version: str | None,
) -> None:
    _set(job, versions=versions, open_version=open_version)
    registry_persist(JOBS_DIR)
    copy_saved_fields(job, JOBS_DIR / job.id)


@router.get("/{job_id}/versions")
def list_versions(job_id: str) -> dict:
    """The song's versions and the one that opens with it, in any status."""
    return _payload(_song(job_id))


@router.post("/{job_id}/versions/{version_id}/open")
def open_version(job_id: str, version_id: str) -> dict:
    """Make `version_id` the version the song opens with."""
    with metadata_lock:
        job = _writable_song(job_id)
        versions = versions_of(job)
        _version(versions, version_id)
        if version_id != open_version_of(job, versions):
            _save(job, job.versions, version_id)
        return _payload(job)


@router.patch("/{job_id}/versions/{version_id}")
def rename_version(job_id: str, version_id: str, body: VersionNameBody) -> dict:
    """Name a version. Naming the implicit default records it."""
    with metadata_lock:
        job = _writable_song(job_id)
        versions = versions_of(job)
        _version(versions, version_id)["name"] = body.name
        _save(job, versions, job.open_version)
        return _payload(job)


@router.post("/{job_id}/versions", status_code=201)
def save_as_new_version(job_id: str, body: NewVersionBody) -> dict:
    """Add a version showing `stems`, opened at once when `open` is true."""
    with metadata_lock:
        job = _writable_song(job_id)
        stems = _known_stems(body.stems)
        versions = versions_of(job)
        _room_for_one_more(versions)
        version = new_version(versions, body.name, stems)
        versions.append(version)
        _save(job, versions, version["id"] if body.open else job.open_version)
        return {"version": version, **_payload(job)}


def _find_or_make(
    versions: list[dict[str, Any]],
    wanted: list[str],
    name: str,
) -> tuple[dict[str, Any], bool]:
    """The version showing exactly `wanted`, or a new one added to `versions`;
    and whether it is new."""
    existing = find_by_stems(versions, wanted)
    if existing is not None:
        return existing, False
    _room_for_one_more(versions)
    version = new_version(versions, name, wanted)
    versions.append(version)
    return version, True


def _open_extracted(job: Job, wanted: list[str], name: str) -> str:
    """Open the version showing `wanted` once its stems are in, saving the
    song's new stem URLs with it."""
    versions = versions_of(job)
    if find_by_stems(versions, wanted) is None and not _has_room(versions):
        raise ExtractFailed(TOO_MANY_VERSIONS, EXTRACT_FAILED_TOO_MANY_VERSIONS)
    version, created = _find_or_make(versions, wanted, name)
    _save(job, versions if created else job.versions, version["id"])
    return version["id"]


def _extract_in_place(
    job: Job,
    versions: list[dict[str, Any]],
    wanted: list[str],
    name: str,
) -> tuple[dict, int]:
    version, created = _find_or_make(versions, wanted, name)
    if created or version["id"] != open_version_of(job, versions):
        _save(job, versions if created else job.versions, version["id"])
    status = 201 if created else 200
    return {"version": version, "created": created, **_payload(job)}, status


def _stems_dir(job: Job) -> Path:
    return JOBS_DIR / job.id / "stems"


def _start_extract(
    job: Job,
    versions: list[dict[str, Any]],
    wanted: list[str],
    missing: list[str],
    name: str,
) -> tuple[dict, int, Coroutine[None, None, None]]:
    if find_by_stems(versions, wanted) is None:
        _room_for_one_more(versions)
    if is_relocating():
        raise HTTPException(status_code=409, detail=STEMS_FOLDER_MOVING_IMPORT)
    source = _retained_source(job.id) or link_of(job)
    if source is None:
        raise HTTPException(status_code=409, detail=SOURCE_GONE)
    run = claim_extract(job, missing, wanted, name)
    if run is None:
        raise HTTPException(status_code=409, detail=EXTRACT_RUNNING)
    task = run_extract(job, _stems_dir(job), source, run, _open_extracted)
    return {"extracting": extract_view(job), **_payload(job)}, 202, task


def _extract(
    job_id: str,
    body: ExtractBody,
) -> tuple[dict, int, Coroutine[None, None, None] | None]:
    with metadata_lock:
        job = _writable_song(job_id)
        versions = versions_of(job)
        source = _version(versions, body.source)
        added = _known_stems(body.stems)
        if set(added) & set(source["stems"]):
            raise HTTPException(status_code=422, detail=STEMS_ALREADY_IN_VERSION)
        wanted = clean_stems(source["stems"] + added)
        missing = missing_stems(_stems_dir(job), wanted)
        if missing:
            return _start_extract(job, versions, wanted, missing, body.name)
        return (*_extract_in_place(job, versions, wanted, body.name), None)


@router.post("/{job_id}/versions/extract", status_code=201)
async def extract_more_stems(job_id: str, body: ExtractBody, response: Response) -> dict:
    """Open the version showing `from`'s stems plus `stems`, made (201) when
    none shows exactly those, else the existing one (200) under its own name.
    When the song is missing a stem file for it, 202 instead: the stems are
    extracted from the song's kept audio, or its link's audio downloaded
    again, followed by GET .../versions/extract, and the version opens once
    they are in. 409 when an upload's audio is not kept or an extraction is
    already going."""
    payload, status, task = await asyncio.to_thread(_extract, job_id, body)
    if task is not None:
        start_run_task(task)
    response.status_code = status
    return payload


@router.get("/{job_id}/versions/extract")
def get_extract(job_id: str) -> dict:
    """Where the song's extraction stands: {"state": "running" | "done" |
    "failed" | "cancelled", "phase", "progress" (0 to 1), "stems", "error",
    "version_id"}, or {"state": "idle"} when there is none."""
    return extract_view(_song(job_id))


@router.post("/{job_id}/versions/extract/cancel")
def cancel_extracting(job_id: str) -> dict:
    """Stop the song's extraction, leaving the song as it was. Nothing else
    running on the song is stopped."""
    job = _song(job_id)
    run = EXTRACT_RUNS.current(job_id)
    if cancel_extract(job) and run is not None and run.started:
        _terminate_worker(job_id)
    return extract_view(job)


@router.delete("/{job_id}/versions/{version_id}")
def delete_version(job_id: str, version_id: str) -> dict:
    """Forget a version. The song's last one is refused: the song goes to the
    Trash instead, which the page does through POST .../trash."""
    with metadata_lock:
        job = _writable_song(job_id)
        versions = versions_of(job)
        version = _version(versions, version_id)
        if len(versions) == 1:
            raise HTTPException(status_code=409, detail=LAST_VERSION_KEPT)
        open_id = open_version_of(job, versions)
        versions.remove(version)
        if open_id == version_id:
            open_id = versions[0]["id"]
        _save(job, versions, open_id)
        return _payload(job)
