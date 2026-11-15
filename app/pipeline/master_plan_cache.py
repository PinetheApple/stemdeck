"""On-disk cache of measured masters (app/pipeline/mastering.py).

Measuring a master runs ffmpeg over the whole song two to five times, so a
plan is measured once and kept as a small JSON file. The export, a region
export and the loudness readout of the same mix then share one measurement.
The key holds everything the measurement depends on: the input graph (lanes,
gains, pitch, EQ, master EQ), the master settings, the effective ceiling, the
rate, and each stem file's path, size and mtime, so a stem that is separated
again is measured again. Bump PLAN_CACHE_VERSION when the plan's maths change.

At most MASTER_PLAN_CONCURRENCY songs are measured at once on this server,
and one mix is never measured twice at the same time (an export and the
readout often ask together). Unreadable entries are measured again; the
oldest entries past MASTER_PLAN_MAX_FILES are pruned on write.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import uuid
from pathlib import Path

from app.core.config import MASTER_PLAN_CACHE_DIR, MASTER_PLAN_CONCURRENCY, MASTER_PLAN_MAX_FILES
from app.pipeline.mastering import (
    LOGGER_NAME,
    MasterPlan,
    MasterSettings,
    Measurer,
    effective_ceiling,
    measure_chain,
    run_plan,
)

logger = logging.getLogger(LOGGER_NAME)

PLAN_CACHE_VERSION = "1"

_plan_slots = asyncio.Semaphore(MASTER_PLAN_CONCURRENCY)
_plan_locks: dict[str, asyncio.Lock] = {}


def plan_cache_key(
    stems: list[Path],
    graph: str,
    settings: MasterSettings,
    ceiling_db: float,
    rate: int,
) -> str:
    """Everything the measurement depends on, the stem files' stats included."""
    files = []
    for path in stems:
        st = path.stat()
        files.append(f"{path}:{st.st_size}:{st.st_mtime_ns}")
    parts = [PLAN_CACHE_VERSION, ";".join(files), graph, settings.fragment()]
    raw = "|".join([*parts, f"{ceiling_db:.1f}", str(rate)])
    return hashlib.sha1(raw.encode("utf-8"), usedforsecurity=False).hexdigest()


def read_cache(path: Path) -> dict | None:
    """A cached JSON object, or None when it is missing or unreadable."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        logger.debug("unreadable cache entry %s", path, exc_info=True)
        return None
    return data if isinstance(data, dict) else None


def _prune(cache_dir: Path, keep: Path, max_files: int) -> None:
    try:
        entries = sorted(
            (p for p in cache_dir.iterdir() if p.is_file() and not p.name.startswith(".")),
            key=lambda p: p.stat().st_mtime,
        )
        for old in entries[: max(0, len(entries) - max_files)]:
            if old != keep:
                old.unlink(missing_ok=True)
    except OSError:
        logger.debug("cache prune failed in %s", cache_dir, exc_info=True)


def write_cache(path: Path, body: dict, max_files: int) -> None:
    """Write ``body`` atomically, then keep only the newest ``max_files``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(body, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)
    _prune(path.parent, path, max_files)


@contextlib.asynccontextmanager
async def keyed_lock(locks: dict[str, asyncio.Lock], key: str):
    """Hold the lock for ``key``, so one entry is never measured twice at once."""
    lock = locks.setdefault(key, asyncio.Lock())
    try:
        async with lock:
            yield
    finally:
        if not lock.locked():
            locks.pop(key, None)


def _read_plan(path: Path) -> MasterPlan | None:
    data = read_cache(path)
    try:
        return None if data is None else MasterPlan.from_json(data)
    except (KeyError, TypeError, ValueError):
        logger.debug("unreadable master plan %s", path, exc_info=True)
        return None


async def cached_plan(
    stems: list[Path],
    graph: str,
    settings: MasterSettings,
    output_format: str,
    rate: int,
    measure: Measurer = measure_chain,
) -> MasterPlan:
    """The plan for ``graph`` over ``stems`` (input i is stems[i]), measured
    once and never twice at the same time. Raises MeasureError."""
    ceiling = effective_ceiling(settings, output_format)
    key = await asyncio.to_thread(plan_cache_key, stems, graph, settings, ceiling, rate)
    path = MASTER_PLAN_CACHE_DIR / f"{key}.json"
    async with keyed_lock(_plan_locks, key):
        cached = await asyncio.to_thread(_read_plan, path)
        if cached is not None:
            return cached
        inputs = [arg for p in stems for arg in ("-i", str(p))]
        async with _plan_slots:
            plan = await run_plan(inputs, graph, settings, ceiling, rate, measure)
        await asyncio.to_thread(write_cache, path, plan.to_json(), MASTER_PLAN_MAX_FILES)
        return plan
