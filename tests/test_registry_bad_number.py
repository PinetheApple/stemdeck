"""A number JSON cannot carry costs only that field (upstream PR 888, #88).

Python's json reads NaN and Infinity, so a damaged or hand-edited
registry.json or metadata.json loaded them as they were. The song's live
state then went out as `NaN`, which no browser parses, and every save wrote
the value back.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import registry as _registry
from app.core.models import Job
from app.core.registry import registry_path
from app.core.song_folder import STEMS_COMPLETE

GOOD = "a1b2c3d4e5f6"
BAD = "b1b2c3d4e5f6"
GOOD_LUFS = -9.5
NON_FINITE = [math.nan, math.inf, -math.inf]
SSE_DATA = "data: "


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()


def _strict_json(text: str) -> dict:
    def refuse(token: str) -> float:
        raise ValueError(f"{token} is not JSON")

    return json.loads(text, parse_constant=refuse)


def _live_state(job_id: str) -> dict:
    """The first event a browser gets for the song, parsed as strictly as it would."""
    from app.main import app

    response = TestClient(app).get(f"/api/jobs/{job_id}/events")
    assert response.status_code == 200
    frame = next(line for line in response.text.splitlines() if line.startswith(SSE_DATA))
    return _strict_json(frame.removeprefix(SSE_DATA))


def _saved_registry(root: Path) -> dict:
    _registry.persist(root)
    return _strict_json(registry_path(root).read_text(encoding="utf-8"))


def _record(job_id: str, **kw) -> dict:
    return Job(id=job_id, status="done", title="Song", lufs=GOOD_LUFS, **kw).to_record()


def _finished_folder(root: Path, job_id: str, meta: dict) -> None:
    stems = root / job_id / "stems"
    stems.mkdir(parents=True)
    (stems / "vocals.wav").write_bytes(b"RIFF")
    (stems / STEMS_COMPLETE).write_text("", encoding="utf-8")
    (root / job_id / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")


@pytest.mark.parametrize("value", NON_FINITE)
@pytest.mark.parametrize(
    ("field", "key"),
    [("lufs", "lufs"), ("duration_sec", "duration"), ("bpm", "bpm"), ("trashed_at", "trashed_at")],
)
def test_a_registry_number_json_cannot_carry_is_dropped(tmp_path: Path, field, key, value):
    bad = {**_record(BAD), field: value}
    registry_path(tmp_path).write_text(
        json.dumps({"version": 1, "jobs": [_record(GOOD, favorite=True), bad]}),
        encoding="utf-8",
    )

    _registry.restore(tmp_path)

    state = _live_state(BAD)
    assert state["title"] == "Song"
    assert state[key] is None
    assert _registry.get(GOOD).favorite is True
    assert _registry.get(GOOD).lufs == GOOD_LUFS
    saved = _saved_registry(tmp_path)["jobs"]
    assert sorted(r["id"] for r in saved) == [GOOD, BAD]
    assert list(tmp_path.glob("registry.json.bad-*")) == []


@pytest.mark.parametrize("value", NON_FINITE)
def test_a_metadata_number_json_cannot_carry_is_dropped(tmp_path: Path, value):
    _finished_folder(tmp_path, GOOD, {"title": "Good", "duration_sec": 200.0})
    _finished_folder(tmp_path, BAD, {"title": "Bad", "duration_sec": value, "lufs": value})

    _registry.restore(tmp_path)

    state = _live_state(BAD)
    assert state["title"] == "Bad"
    assert state["duration"] is None
    assert state["lufs"] is None
    assert _live_state(GOOD)["duration"] == 200.0
    assert sorted(r["id"] for r in _saved_registry(tmp_path)["jobs"]) == [GOOD, BAD]
