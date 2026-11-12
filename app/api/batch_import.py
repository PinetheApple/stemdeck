"""Batch import review: what a pasted list of links, and a folder's file names,
would import, before anything is queued.

Read-only on purpose. The review list lets the user drop items, so queuing is the
client looping over the existing create routes with what it kept, one request per
item; a batch create route would only take this list back. Each link is read
here because its row needs a title and a length, and the length decides whether
it can be queued at all.

A song the library already holds is flagged by the same rule the playlist import
skips it by, so the two imports never disagree about what "in the library" means.
Files are matched by name only: their bytes are not sent until they are queued,
and the upload route stays the authority on type, size and length.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from yt_dlp import YoutubeDL

from app.api.jobs import _sanitize_title
from app.api.playlist import SKIP_IN_LIBRARY, SKIP_TOO_LONG, _capacity_left, _holds_song
from app.core.config import MAX_PENDING_UPLOAD_JOBS
from app.core.registry import all_jobs as registry_all_jobs
from app.core.registry import pending_count as registry_pending_count
from app.core.settings import get_cookies_file, get_max_duration_sec, get_playlist_max_items
from app.pipeline.download import (
    _ALLOWED_EXTRACTORS,
    InvalidYouTubeURL,
    _base_ydl_opts,
    _is_bot_check,
    expand_playlist,
    is_playlist_url,
    validate_youtube_url,
)

logger = logging.getLogger("stemdeck.api")

router = APIRouter(tags=["import"])

STATUS_OK = "ok"
STATUS_IN_LIBRARY = SKIP_IN_LIBRARY
STATUS_TOO_LONG = SKIP_TOO_LONG
STATUS_NOT_A_LINK = "not_a_link"
STATUS_UNAVAILABLE = "unavailable"

MAX_BATCH_LINKS = 100
MAX_BATCH_FILES = 500

# Each read is a yt-dlp round trip of a second or two. A few at once keeps a
# pasted list of 30 links quick without opening 30 connections to YouTube.
_PROBE_CONCURRENCY = 4
_probe_semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)

_LOCAL_SOURCE_PREFIX = "local:"

Item = dict[str, Any]


class BatchPreviewRequest(BaseModel):
    links: list[str] = Field(default_factory=list, max_length=MAX_BATCH_LINKS)
    files: list[str] = Field(default_factory=list, max_length=MAX_BATCH_FILES)


def probe_link(url: str) -> dict[str, Any]:
    """A link's metadata, read without downloading or resolving formats.

    Same cookie rule as an import: without them first, with them only once
    YouTube's bot check has turned the request away.
    """

    def extract(use_cookies: bool) -> dict[str, Any]:
        opts = {
            **_base_ydl_opts(_ALLOWED_EXTRACTORS, use_cookies=use_cookies),
            "noplaylist": True,
            "skip_download": True,
        }
        with YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False, process=False) or {}

    try:
        return extract(False)
    except Exception as exc:
        if not _is_bot_check(exc) or get_cookies_file() is None:
            raise
        return extract(True)


def _item(
    line: str,
    url: str | None,
    *,
    status: str = STATUS_OK,
    title: str | None = None,
    artist: str | None = None,
    duration: Any = None,
    playlist: dict[str, Any] | None = None,
) -> Item:
    return {
        "input": line,
        "url": url,
        "title": title or None,
        "artist": artist or None,
        "duration_sec": duration if isinstance(duration, int | float) else None,
        "status": status,
        "existing_job_id": None,
        "playlist": playlist,
    }


async def _read_link(line: str, url: str) -> Item:
    try:
        async with _probe_semaphore:
            info = await asyncio.to_thread(probe_link, url)
    except Exception:
        logger.info("batch preview: could not read %s", url, exc_info=True)
        return _item(line, url, status=STATUS_UNAVAILABLE)
    return _item(
        line,
        url,
        title=info.get("title"),
        artist=info.get("artist") or info.get("uploader") or info.get("channel"),
        duration=info.get("duration"),
    )


async def _read_playlist(line: str) -> tuple[list[Item], dict[str, Any] | None]:
    try:
        async with _probe_semaphore:
            result = await asyncio.to_thread(expand_playlist, line, get_playlist_max_items())
    except Exception:
        logger.info("batch preview: could not expand %s", line, exc_info=True)
        return [_item(line, None, status=STATUS_UNAVAILABLE)], None
    tracks = result["items"]
    group = {"url": result["playlist_url"], "title": result["playlist_title"]}
    items = [
        _item(
            line,
            track["url"],
            title=track["title"],
            artist=track["artist"],
            duration=track["duration"],
            playlist={**group, "index": index},
        )
        for index, track in enumerate(tracks, start=1)
    ]
    summary = {
        "input": line,
        **group,
        "found": len(tracks),
        "unavailable": result["unavailable"],
        "truncated": result["truncated"],
    }
    return items, summary


async def _read_line(line: str) -> tuple[list[Item], dict[str, Any] | None]:
    if is_playlist_url(line):
        return await _read_playlist(line)
    try:
        url = validate_youtube_url(line)
    except InvalidYouTubeURL:
        return [_item(line, None, status=STATUS_NOT_A_LINK)], None
    return [await _read_link(line, url)], None


def _first_of_each_url(items: list[Item]) -> list[Item]:
    seen: set[str] = set()
    kept = []
    for item in items:
        url = item["url"]
        if url is not None:
            if url in seen:
                continue
            seen.add(url)
        kept.append(item)
    return kept


def _library_jobs() -> dict[str, str]:
    """The library's live copies, by source URL, to their job id."""
    return {job.source_url: job.id for job in registry_all_jobs().values() if _holds_song(job)}


def _judge(item: Item, library: dict[str, str], max_duration: int) -> None:
    item["existing_job_id"] = library.get(item["url"])
    if item["status"] != STATUS_OK:
        return
    duration = item["duration_sec"]
    if duration is not None and duration > max_duration:
        item["status"] = STATUS_TOO_LONG
    elif item["existing_job_id"] is not None:
        item["status"] = STATUS_IN_LIBRARY


def _file_item(name: str, library: dict[str, str]) -> Item:
    job_id = library.get(f"{_LOCAL_SOURCE_PREFIX}{_sanitize_title(name)}")
    return {
        "name": name,
        "status": STATUS_OK if job_id is None else STATUS_IN_LIBRARY,
        "existing_job_id": job_id,
    }


async def _parse(request: Request) -> BatchPreviewRequest:
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid JSON: {e}") from e
    try:
        return BatchPreviewRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.post("/preview")
async def preview_batch(request: Request) -> dict[str, Any]:
    """Read every link and file name and say what queuing each would do. Creates nothing."""
    payload = await _parse(request)
    lines = [line.strip() for line in payload.links if line.strip()]
    results = await asyncio.gather(*(_read_line(line) for line in lines))
    items = _first_of_each_url([item for found, _ in results for item in found])

    library = _library_jobs()
    max_duration = get_max_duration_sec()
    for item in items:
        _judge(item, library, max_duration)

    return {
        "items": items,
        "playlists": [summary for _, summary in results if summary is not None],
        "files": [_file_item(name, library) for name in payload.files],
        "max_duration_sec": max_duration,
        "capacity_left": {
            "links": _capacity_left(),
            "files": max(0, MAX_PENDING_UPLOAD_JOBS - registry_pending_count(uploads=True)),
        },
    }
