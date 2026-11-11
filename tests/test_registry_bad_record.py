"""One bad record in registry.json costs only itself (upstream PR 888, #88).

A single record that could not be read used to abort the whole load. The
orphan recovery that followed rebuilt the finished songs from their folders,
and its persist wrote that over everything only the registry held: favourites,
the Trash, the queue.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core import registry as _registry
from app.core.models import Job
from app.core.registry import registry_path

GOOD = "a1b2c3d4e5f6"
OTHER = "b1b2c3d4e5f6"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()


def _song_folder(root: Path, job_id: str) -> None:
    stems = root / job_id / "stems"
    stems.mkdir(parents=True)
    (stems / "vocals.wav").write_bytes(b"RIFF")
    (root / job_id / "metadata.json").write_text(json.dumps({"title": "T"}), encoding="utf-8")


def _write_registry(root: Path, records: list, **extra) -> None:
    body = {"version": 1, "jobs": records, **extra}
    registry_path(root).write_text(json.dumps(body), encoding="utf-8")


def _record(job_id: str, **kw) -> dict:
    return Job(id=job_id, status="done", title="Song", **kw).to_record()


def _set_aside(root: Path) -> list[Path]:
    return sorted(root.glob("registry.json.bad-*"))


@pytest.mark.parametrize(
    "bad",
    ["junk", 42, None, ["a list"], {"status": "done"}, {"id": "../etc"}, {"id": "abc\n"}],
)
def test_a_bad_record_costs_only_itself(tmp_path: Path, bad):
    _song_folder(tmp_path, GOOD)
    # A delete whose files outlived it: its tombstone must survive the load.
    _song_folder(tmp_path, OTHER)
    _write_registry(tmp_path, [_record(GOOD, favorite=True), bad], deleted=[OTHER])

    _registry.restore(tmp_path)

    assert _registry.get(GOOD).favorite is True
    assert _registry.is_deleted(OTHER)
    assert OTHER not in _registry.all_jobs()
    kept = _set_aside(tmp_path)
    assert len(kept) == 1
    assert json.loads(kept[0].read_text(encoding="utf-8"))["records"] == [bad]


@pytest.mark.parametrize(
    "fields",
    [
        {"status": "separating", "resume_attempts": "1"},
        {"status": "queued", "queue_position": None},
        {"created_at": "yesterday"},
        {"created_at": True},
    ],
)
def test_a_record_with_a_value_the_registry_orders_by_costs_only_itself(tmp_path: Path, fields):
    bad = {**_record(OTHER), **fields}
    _write_registry(tmp_path, [_record(GOOD, favorite=True), bad])

    _registry.restore(tmp_path)
    _registry.persist(tmp_path)

    assert _registry.get(GOOD).favorite is True
    assert OTHER not in _registry.all_jobs()
    saved = json.loads(registry_path(tmp_path).read_text(encoding="utf-8"))["jobs"]
    assert [r["id"] for r in saved] == [GOOD]


def test_a_repeated_record_keeps_the_first(tmp_path: Path):
    _write_registry(tmp_path, [_record(GOOD, favorite=True), _record(GOOD, favorite=False)])

    _registry.restore(tmp_path)

    assert _registry.get(GOOD).favorite is True
    assert len(_set_aside(tmp_path)) == 1


def test_a_bad_record_is_set_aside_once(tmp_path: Path):
    _write_registry(tmp_path, [_record(GOOD), "junk"])

    for _ in range(3):
        _registry._jobs.clear()
        _registry.restore(tmp_path)

    assert len(_set_aside(tmp_path)) == 1
    assert GOOD in _registry.all_jobs()


@pytest.mark.parametrize("version", [None, "2", [2]])
def test_a_registry_version_that_is_not_a_number_still_loads(tmp_path: Path, version):
    registry_path(tmp_path).write_text(
        json.dumps({"version": version, "jobs": [_record(GOOD, favorite=True)]}),
        encoding="utf-8",
    )

    _registry.restore(tmp_path)

    assert _registry.get(GOOD).favorite is True


def test_one_folder_that_cannot_be_rebuilt_costs_only_itself(tmp_path: Path, monkeypatch):
    _song_folder(tmp_path, GOOD)
    _song_folder(tmp_path, OTHER)
    real = _registry._recover_done_job

    def broken_for_one(job_dir: Path, *args):
        if job_dir.name == GOOD:
            raise RecursionError("nested too deep")
        return real(job_dir, *args)

    monkeypatch.setattr(_registry, "_recover_done_job", broken_for_one)

    _registry.restore(tmp_path)

    assert OTHER in _registry.all_jobs()
    saved = json.loads(registry_path(tmp_path).read_text(encoding="utf-8"))["jobs"]
    assert [r["id"] for r in saved] == [OTHER]
