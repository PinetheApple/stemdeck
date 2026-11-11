"""What only the registry held survives a registry rebuilt from the song
folders (upstream PR 883, #88).

A lost, empty or corrupt registry.json is rebuilt from each song's folder.
That rebuild used to reset the favourite, the Trash, the stem selection, the
source and the date added, because only registry.json held them.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.jobs as jobs_mod
from app.core import registry as _registry
from app.core.models import Job
from app.core.registry import registry_path
from app.main import app
from app.pipeline.runner import _write_metadata

JOB = "a1b2c3d4e5f6"
ADDED = 1_700_000_000.0


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()


def _stems(job_dir: Path) -> None:
    stems = job_dir / "stems"
    stems.mkdir(parents=True)
    for name in ("vocals", "drums"):
        (stems / f"{name}.wav").write_bytes(b"RIFF")


def _finished(root: Path, **kw) -> Job:
    job = Job(id=JOB, status="done", title="Song", created_at=ADDED, **kw)
    _stems(root / JOB)
    _write_metadata(job, root / JOB)
    _registry.register(job)
    return job


def _lose_registry_and_restart(root: Path) -> Job:
    registry_path(root).unlink(missing_ok=True)
    _registry._jobs.clear()
    _registry.restore(root)
    return _registry.get(JOB)


def _meta(root: Path) -> dict:
    return json.loads((root / JOB / "metadata.json").read_text(encoding="utf-8"))


def test_a_finished_song_keeps_what_only_the_registry_held(tmp_path: Path):
    _finished(
        tmp_path,
        favorite=True,
        trashed_at=ADDED + 5,
        selected_stems=["vocals"],
        source_url="https://www.youtube.com/watch?v=abcdefghijk",
        source_format="m4a",
    )

    job = _lose_registry_and_restart(tmp_path)

    assert job.favorite is True
    assert job.trashed_at == ADDED + 5
    assert job.selected_stems == ["vocals"]
    assert job.source_url == "https://www.youtube.com/watch?v=abcdefghijk"
    assert job.source_format == "m4a"
    assert job.created_at == ADDED


@pytest.mark.parametrize(
    ("path", "body", "field", "value"),
    [
        ("favorite", {"favorite": True}, "favorite", True),
        ("trash", None, "trashed_at", float),
    ],
)
def test_a_change_after_the_song_finished_reaches_its_folder(path, body, field, value):
    root = jobs_mod.JOBS_DIR
    _finished(root)
    client = TestClient(app)
    if body is None:
        assert client.post(f"/api/jobs/{JOB}/{path}").status_code == 200
    else:
        assert client.put(f"/api/jobs/{JOB}/{path}", json=body).status_code == 200

    job = _lose_registry_and_restart(root)

    got = getattr(job, field)
    assert isinstance(got, value) if isinstance(value, type) else got == value


def test_restore_from_the_trash_reaches_its_folder():
    root = jobs_mod.JOBS_DIR
    _finished(root, trashed_at=ADDED + 5)

    assert TestClient(app).post(f"/api/jobs/{JOB}/restore").status_code == 200

    assert _lose_registry_and_restart(root).trashed_at is None


def test_an_older_library_gets_the_copy_once_on_upgrade(tmp_path: Path):
    _stems(tmp_path / JOB)
    (tmp_path / JOB / "metadata.json").write_text(json.dumps({"title": "Old"}), encoding="utf-8")
    record = Job(id=JOB, status="done", title="Old", favorite=True, created_at=ADDED).to_record()
    registry_path(tmp_path).write_text(
        json.dumps({"version": 1, "jobs": [record]}), encoding="utf-8"
    )

    _registry.restore(tmp_path)

    meta = _meta(tmp_path)
    assert meta["title"] == "Old"
    assert meta["favorite"] is True
    assert meta["created_at"] == ADDED
    assert json.loads(registry_path(tmp_path).read_text(encoding="utf-8"))["version"] == 2


@pytest.mark.parametrize(
    "hostile",
    [
        {"favorite": "yes"},
        {"trashed_at": "soon"},
        {"trashed_at": float("nan")},
        {"created_at": -5},
        {"created_at": True},
        {"selected_stems": ["../evil"]},
        {"selected_stems": "vocals"},
        {"source_url": 7},
        {"source_format": "exe"},
    ],
)
def test_a_bad_value_in_metadata_keeps_what_the_folder_gives(tmp_path: Path, hostile):
    _stems(tmp_path / JOB)
    meta = {"title": "T", **hostile}
    (tmp_path / JOB / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")

    _registry.restore(tmp_path)

    job = _registry.get(JOB)
    blank = Job(id=JOB)
    for name in hostile:
        if name == "created_at":
            assert job.created_at == (tmp_path / JOB).stat().st_mtime
        elif name == "selected_stems":
            assert job.selected_stems == ["vocals", "drums"]
        else:
            assert getattr(job, name) == getattr(blank, name)
    json.dumps(job.to_state(), allow_nan=False)


def test_a_registry_that_loads_still_wins(tmp_path: Path):
    _finished(tmp_path, favorite=True)
    _registry.persist(tmp_path)
    _registry.get(JOB).favorite = False
    _registry.persist(tmp_path)

    _registry._jobs.clear()
    _registry.restore(tmp_path)

    assert _registry.get(JOB).favorite is False


def test_a_song_finished_as_the_process_died_keeps_the_registry_fields(tmp_path: Path):
    _stems(tmp_path / JOB)
    (tmp_path / JOB / "metadata.json").write_text(json.dumps({"title": "T"}), encoding="utf-8")
    record = Job(
        id=JOB,
        status="separating",
        title="T",
        favorite=True,
        selected_stems=["drums"],
        created_at=ADDED,
    ).to_record()
    registry_path(tmp_path).write_text(
        json.dumps({"version": 2, "jobs": [record]}), encoding="utf-8"
    )

    _registry.restore(tmp_path)

    job = _registry.get(JOB)
    assert job.status == "done"
    assert job.favorite is True
    assert job.selected_stems == ["drums"]
    assert job.created_at == ADDED
