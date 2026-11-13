"""The routes that list, open, rename, save, extract and delete a song's
versions. Every GET, and opening the open version, writes nothing."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from app.api.jobs import RESTORE_FROM_TRASH_FIRST
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
from app.core.stem_files import stem_exists
from app.core.versions import (
    clean_stems,
    find_by_stems,
    find_version,
    new_version,
    open_version_of,
    versions_of,
)

router = APIRouter(tags=["jobs"])

JOB_NOT_FOUND = "job not found"
VERSION_NOT_FOUND = "version not found"
SONG_NOT_READY = "the song is not ready"
NO_KNOWN_STEM = "choose at least one known stem"
TOO_MANY_VERSIONS = "this song has too many versions"
STEMS_ALREADY_IN_VERSION = "those stems are already in this version"
STEM_FILES_MISSING = "this song is missing stem files; import it again"
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


def _room_for_one_more(versions: list[dict[str, Any]]) -> None:
    if len(versions) >= MAX_VERSIONS_PER_SONG:
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


@router.post("/{job_id}/versions/extract", status_code=201)
def extract_more_stems(job_id: str, body: ExtractBody, response: Response) -> dict:
    """Open the version showing `from`'s stems plus `stems`, made (201) when
    none shows exactly those, else the existing one (200) under its own name."""
    with metadata_lock:
        job = _writable_song(job_id)
        versions = versions_of(job)
        source = _version(versions, body.source)
        added = _known_stems(body.stems)
        if set(added) & set(source["stems"]):
            raise HTTPException(status_code=422, detail=STEMS_ALREADY_IN_VERSION)
        wanted = clean_stems(source["stems"] + added)
        stems_dir = JOBS_DIR / job.id / "stems"
        if not all(stem_exists(stems_dir, name) for name in wanted):
            raise HTTPException(status_code=409, detail=STEM_FILES_MISSING)
        existing = find_by_stems(versions, wanted)
        if existing is not None:
            if existing["id"] != open_version_of(job, versions):
                _save(job, job.versions, existing["id"])
            response.status_code = 200
            return {"version": existing, "created": False, **_payload(job)}
        _room_for_one_more(versions)
        version = new_version(versions, body.name, wanted)
        versions.append(version)
        _save(job, versions, version["id"])
        return {"version": version, "created": True, **_payload(job)}


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
