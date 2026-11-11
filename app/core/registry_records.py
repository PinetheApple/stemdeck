"""Reading registry.json one record at a time, so a bad record costs only itself."""

from __future__ import annotations

import json
import logging
import math
import time
import uuid
from pathlib import Path

from app.core.config import JOB_ID_RE
from app.core.models import Job

logger = logging.getLogger("stemdeck.registry")

# Hex digits after the time in a registry.json.bad-<time>-<hex> name, so two
# loads in one second do not overwrite each other's copy.
_BAD_SUFFIX_HEX = 6
# Compared and sorted by every load and save: a record holding anything but a
# number in one of these broke the load, or every persist after it.
_ORDER_FIELDS = ("created_at", "queue_position", "resume_attempts")


def record_id(record: object) -> str | None:
    rid = record.get("id") if isinstance(record, dict) else None
    return rid if isinstance(rid, str) and JOB_ID_RE.match(rid) else None


def read_record(record: object, rid: str | None, seen: dict[str, Job]) -> Job:
    """One registry record as a Job. Raises ValueError for a bad one, which
    costs only itself instead of the whole load (upstream PR 888)."""
    if rid is None:
        raise ValueError("no valid job id")
    if rid in seen:
        raise ValueError("repeated")
    job = Job.from_record(record)  # type: ignore[arg-type]
    for name in _ORDER_FIELDS:
        value = getattr(job, name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{name} is not a number")
        if not math.isfinite(value):
            raise ValueError(f"{name} is not finite")
    return job


def keep_bad_records(path: Path, records: list) -> bool:
    """Save the raw records the load skipped beside the registry, as
    registry.json.bad-<time>, so dropping them is never silent. True when
    they were kept."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    target = path.with_name(f"{path.name}.bad-{stamp}-{uuid.uuid4().hex[:_BAD_SUFFIX_HEX]}")
    try:
        target.write_text(json.dumps({"records": records}, indent=2) + "\n", encoding="utf-8")
    except (OSError, TypeError, ValueError):
        logger.warning("could not keep bad registry records aside", exc_info=True)
        return False
    logger.warning("kept %d registry record(s) aside in %s", len(records), target.name)
    return True
