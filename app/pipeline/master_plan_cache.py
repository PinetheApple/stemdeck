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
import hashlib
import json
import logging
import os
import uuid
from pathlib import Path

from app.core.config import MASTER_PLAN_CONCURRENCY, MASTER_PLAN_MAX_FILES
from app.pipeline.mastering import (
    MasterPlan,
    MasterSettings,
    Measurer,
    effective_ceiling,
    measure_chain,
    run_plan,
)

logger = logging.getLogger("stemdeck.mastering")

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


def _read_plan(path: Path) -> MasterPlan | None:
    try:
        return MasterPlan.from_json(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, KeyError, TypeError):
        logger.debug("unreadable master plan %s", path, exc_info=True)
        return None


def _prune(cache_dir: Path, keep: Path) -> None:
    try:
        entries = sorted(
            (p for p in cache_dir.iterdir() if p.is_file() and not p.name.startswith(".")),
            key=lambda p: p.stat().st_mtime,
        )
        for old in entries[: max(0, len(entries) - MASTER_PLAN_MAX_FILES)]:
            if old != keep:
                old.unlink(missing_ok=True)
    except OSError:
        logger.debug("master plan prune failed", exc_info=True)


def _write_plan(path: Path, plan: MasterPlan) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(plan.to_json()), encoding="utf-8")
    os.replace(tmp, path)
    _prune(path.parent, path)


async def cached_plan(
    cache_dir: Path,
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
    path = cache_dir / f"{key}.json"
    lock = _plan_locks.setdefault(key, asyncio.Lock())
    try:
        async with lock:
            cached = await asyncio.to_thread(_read_plan, path)
            if cached is not None:
                return cached
            inputs = [arg for p in stems for arg in ("-i", str(p))]
            async with _plan_slots:
                plan = await run_plan(inputs, graph, settings, ceiling, rate, measure)
            await asyncio.to_thread(_write_plan, path, plan)
            return plan
    finally:
        if not lock.locked():
            _plan_locks.pop(key, None)
