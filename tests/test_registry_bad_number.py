"""A song field holding a NaN, an infinity or a value of the wrong JSON type
is reset to its default when registry.json or metadata.json loads. The rest of
the song and every other song load as before, the live state stays valid
JSON, and the next save no longer holds the value."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import registry as _registry
from app.core.models import Job
from app.core.registry import registry_path
from app.core.registry_records import reset_bad_fields
from app.core.song_folder import STEMS_COMPLETE

GOOD = "a1b2c3d4e5f6"
BAD = "b1b2c3d4e5f6"
GOOD_LUFS = -9.5
NON_FINITE = [math.nan, math.inf, -math.inf]
SSE_DATA = "data: "


@pytest.fixture(autouse=True)
def _isolate_jobs():
    _registry._jobs.clear()
    yield
    _registry._jobs.clear()


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


def _saved_ids(root: Path) -> list[str]:
    _registry.persist(root)
    saved = _strict_json(registry_path(root).read_text(encoding="utf-8"))
    return sorted(record["id"] for record in saved["jobs"])


def _record(job_id: str, **kw) -> dict:
    return Job(id=job_id, status="done", title="Song", lufs=GOOD_LUFS, **kw).to_record()


def _restore_with_bad(root: Path, fields: dict) -> None:
    bad = {**_record(BAD), **fields}
    registry_path(root).write_text(
        json.dumps({"version": 1, "jobs": [_record(GOOD, favorite=True), bad]}),
        encoding="utf-8",
    )
    _registry.restore(root)


def _finished_folder(root: Path, job_id: str, meta: dict) -> None:
    stems = root / job_id / "stems"
    stems.mkdir(parents=True)
    (stems / "vocals.wav").write_bytes(b"RIFF")
    (stems / STEMS_COMPLETE).write_text("", encoding="utf-8")
    (root / job_id / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")


def _assert_only_bad_reset(root: Path, state: dict, key: str, default: object) -> None:
    assert state["title"] == "Song"
    assert state[key] == default
    assert _registry.get(GOOD).favorite is True
    assert _registry.get(GOOD).lufs == GOOD_LUFS
    assert _saved_ids(root) == [GOOD, BAD]
    assert list(root.glob("registry.json.bad-*")) == []


@pytest.mark.parametrize("value", NON_FINITE)
@pytest.mark.parametrize(
    ("field", "key"),
    [("lufs", "lufs"), ("duration_sec", "duration"), ("bpm", "bpm"), ("trashed_at", "trashed_at")],
)
def test_a_non_finite_registry_number_is_reset(tmp_path: Path, field, key, value):
    _restore_with_bad(tmp_path, {field: value})

    _assert_only_bad_reset(tmp_path, _live_state(BAD), key, None)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("stage_timings", {"separate": math.nan}),
        ("stem_presence", {"vocals": math.inf}),
        ("sections", [{"id": "s1", "name": "Verse", "start": -math.inf, "end": 1.0}]),
    ],
)
def test_a_non_finite_number_inside_a_field_resets_the_field(tmp_path: Path, field, value):
    _restore_with_bad(tmp_path, {field: value})

    _assert_only_bad_reset(tmp_path, _live_state(BAD), field, None)


@pytest.mark.parametrize(
    ("field", "value", "default"),
    [("lufs", "loud", None), ("peak_db", [1], None), ("stems", "vocals", [])],
)
def test_a_value_of_the_wrong_type_is_reset(tmp_path: Path, field, value, default):
    """The song view formats lufs and peak_db as numbers and filters stems as a list."""
    _restore_with_bad(tmp_path, {field: value})

    _assert_only_bad_reset(tmp_path, _live_state(BAD), field, default)


def test_a_field_without_a_default_is_left_as_it_is():
    job = Job(id=GOOD)
    job.id = 5  # type: ignore[assignment]

    reset_bad_fields(job)

    assert job.id == 5


@pytest.mark.parametrize("value", NON_FINITE)
def test_a_non_finite_metadata_number_is_reset(tmp_path: Path, value):
    _finished_folder(tmp_path, GOOD, {"title": "Good", "duration_sec": 200.0})
    _finished_folder(tmp_path, BAD, {"title": "Bad", "duration_sec": value, "lufs": value})

    _registry.restore(tmp_path)

    state = _live_state(BAD)
    assert state["title"] == "Bad"
    assert state["duration"] is None
    assert state["lufs"] is None
    assert _live_state(GOOD)["duration"] == 200.0
    assert _saved_ids(tmp_path) == [GOOD, BAD]
