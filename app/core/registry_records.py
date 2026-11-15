"""Reading registry.json one record at a time, so a bad record costs only itself."""

from __future__ import annotations

import dataclasses
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
# The JSON types each base of a Job field annotation stands for. A number field
# takes both, since json reads 1.0 and 1 differently.
_JSON_TYPES: dict[str, tuple[type, ...]] = {
    "None": (type(None),),
    "str": (str,),
    "Literal": (str,),
    "JobStatus": (str,),
    "int": (int, float),
    "float": (int, float),
    "bool": (bool,),
    "list": (list,),
    "dict": (dict,),
}


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
    reset_bad_fields(job)
    return job


def reset_bad_fields(job: Job) -> None:
    """Reset a field of the wrong type or holding NaN or infinity to its
    default; browsers cannot parse NaN, and the UI relies on the types."""
    for f in dataclasses.fields(job):
        value = getattr(job, f.name)
        if _fits(value, f.type) and not _has_non_finite(value):
            continue
        if f.default_factory is not dataclasses.MISSING:
            setattr(job, f.name, f.default_factory())
        elif f.default is not dataclasses.MISSING:
            setattr(job, f.name, f.default)
        else:
            continue
        logger.warning("song %s: %s held a value it cannot, reset", job.id, f.name)


def _fits(value: object, annotation: object) -> bool:
    allowed = _annotation_types(annotation)
    if allowed is None:
        return True
    if isinstance(value, bool):
        return bool in allowed
    return isinstance(value, allowed)


def _has_non_finite(value: object) -> bool:
    if isinstance(value, float):
        return not math.isfinite(value)
    if isinstance(value, dict):
        return any(_has_non_finite(item) for item in value.values())
    if isinstance(value, list):
        return any(_has_non_finite(item) for item in value)
    return False


def _annotation_types(annotation: object) -> tuple[type, ...] | None:
    """The JSON types a Job field's string annotation allows, or None for a
    shape this does not know (the field is then not type-checked)."""
    if not isinstance(annotation, str):
        return None
    allowed: list[type] = []
    for part in annotation.split("|"):
        base = part.strip().split("[", 1)[0]
        if base not in _JSON_TYPES:
            return None
        allowed.extend(_JSON_TYPES[base])
    return tuple(allowed)


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
