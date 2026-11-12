"""Batch import review: what a pasted list of links and a folder's file names would
import. Creates nothing; the client queues each kept item through POST /api/jobs."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.api.jobs import _local_source_url
from app.api.playlist import (
    SKIP_IN_LIBRARY,
    SKIP_TOO_LONG,
    _capacity_left,
    _library_jobs,
    _too_long,
)
from app.api.queue import upload_capacity_left
from app.core.config import TIMEOUT_BATCH_PROBE
from app.core.settings import get_max_duration_sec, get_playlist_max_items
from app.pipeline.download import (
    InvalidYouTubeURL,
    expand_playlist,
    is_playlist_url,
    probe_info,
    validate_youtube_url,
)

logger = logging.getLogger("stemdeck.api")

router = APIRouter(tags=["import"])

STATUS_OK = "ok"
STATUS_NOT_A_LINK = "not_a_link"
STATUS_UNAVAILABLE = "unavailable"

MAX_BATCH_LINKS = 100
MAX_BATCH_FILES = 500

# Each read is a yt-dlp round trip of a second or two. A few at once keeps a
# pasted list of 30 links quick without opening 30 connections to YouTube.
_PROBE_CONCURRENCY = 4
_probe_semaphore = asyncio.Semaphore(_PROBE_CONCURRENCY)

Item = dict[str, Any]
Summary = dict[str, Any]


class BatchPreviewRequest(BaseModel):
    links: list[str] = []
    files: list[str] = []


async def _read(fn: Callable[..., Any], *args: Any) -> Any:
    # A timeout abandons the wait, not the thread: yt-dlp's own socket timeout
    # ends that, and its answer is then dropped.
    async with _probe_semaphore:
        return await asyncio.wait_for(asyncio.to_thread(fn, *args), timeout=TIMEOUT_BATCH_PROBE)


def _item(
    line_no: int,
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
        "line": line_no,
        "url": url,
        "title": title or None,
        "artist": artist or None,
        "duration_sec": duration if isinstance(duration, int | float) else None,
        "status": status,
        "existing_job_id": None,
        "playlist": playlist,
    }


async def _read_link(line_no: int, line: str, url: str) -> Item:
    try:
        info = await _read(lambda: probe_info(url, process=False))
    except Exception:
        logger.info("batch preview: could not read %s", url, exc_info=True)
        return _item(line_no, line, url, status=STATUS_UNAVAILABLE)
    return _item(
        line_no,
        line,
        url,
        title=info.get("title"),
        artist=info.get("artist") or info.get("uploader") or info.get("channel"),
        duration=info.get("duration"),
    )


async def _read_playlist(line_no: int, line: str) -> tuple[list[Item], Summary | None]:
    try:
        result = await _read(expand_playlist, line, get_playlist_max_items())
    except Exception:
        logger.info("batch preview: could not expand %s", line, exc_info=True)
        return [_item(line_no, line, None, status=STATUS_UNAVAILABLE)], None
    group = {"url": result["playlist_url"], "title": result["playlist_title"]}
    items = [
        _item(
            line_no,
            line,
            track["url"],
            title=track["title"],
            artist=track["artist"],
            duration=track["duration"],
            playlist={**group, "index": index},
        )
        for index, track in enumerate(result["items"], start=1)
    ]
    summary = {
        "input": line,
        "line": line_no,
        **group,
        "unavailable": result["unavailable"],
        "truncated": result["truncated"],
    }
    return items, summary


async def _read_line(line_no: int, line: str) -> tuple[list[Item], Summary | None]:
    if is_playlist_url(line):
        return await _read_playlist(line_no, line)
    try:
        url = validate_youtube_url(line)
    except InvalidYouTubeURL:
        return [_item(line_no, line, None, status=STATUS_NOT_A_LINK)], None
    return [await _read_link(line_no, line, url)], None


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


def _counted(summary: Summary, items: list[Item]) -> Summary:
    """``found`` counts the playlist's rows that survived de-duplication, so it
    always matches what the review list shows."""
    rows = [i for i in items if i["playlist"] is not None and i["line"] == summary["line"]]
    return {**summary, "found": len(rows)}


def _judge(item: Item, library: dict[str, str], max_duration: int) -> None:
    item["existing_job_id"] = library.get(item["url"])
    if item["status"] != STATUS_OK:
        return
    if _too_long(item["duration_sec"], max_duration):
        item["status"] = SKIP_TOO_LONG
    elif item["existing_job_id"] is not None:
        item["status"] = SKIP_IN_LIBRARY


def _file_item(name: str, library: dict[str, str]) -> Item:
    job_id = library.get(_local_source_url(name))
    return {
        "name": name,
        "status": STATUS_OK if job_id is None else SKIP_IN_LIBRARY,
        "existing_job_id": job_id,
    }


def _numbered(entries: list[str], cap: int, what: str) -> list[tuple[int, str]]:
    """Non-blank entries with their 1-based position in the request."""
    kept = [(n, e.strip()) for n, e in enumerate(entries, start=1) if e.strip()]
    if len(kept) > cap:
        raise HTTPException(status_code=422, detail=f"At most {cap} {what} at once")
    return kept


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
    """Creates nothing."""
    payload = await _parse(request)
    lines = _numbered(payload.links, MAX_BATCH_LINKS, "links")
    names = [name for _, name in _numbered(payload.files, MAX_BATCH_FILES, "files")]
    results = await asyncio.gather(*(_read_line(n, line) for n, line in lines))
    items = _first_of_each_url([item for found, _ in results for item in found])

    library = _library_jobs()
    max_duration = get_max_duration_sec()
    for item in items:
        _judge(item, library, max_duration)

    return {
        "items": items,
        "playlists": [_counted(s, items) for _, s in results if s is not None],
        "files": [_file_item(name, library) for name in names],
        "max_duration_sec": max_duration,
        "capacity_left": {"links": _capacity_left(), "files": upload_capacity_left()},
    }
