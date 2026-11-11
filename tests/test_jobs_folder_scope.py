"""Reset and the clean-ups remove only StemDeck's own entries in the jobs
folder (upstream PR 886, #88).

The jobs folder can be shared with other things: a Docker or Unraid volume
mapped onto an existing share, or a folder the user already had and picked in
Settings. Reset emptied it entry by entry, and the failed-job sweep removed any
old folder in failed/.
"""

from __future__ import annotations

import os
import time
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core import registry as _registry
from app.core.models import Job
from app.pipeline.collect import sweep_failed_jobs
from app.pipeline.sections import _WORK_PREFIX, sweep_orphaned_workspaces

SONG = "a1b2c3d4e5f6"
OLD = time.time() - 999_999
needs_symlinks = pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()


def _put(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _quarantine(jobs: Path, job_id: str) -> Path:
    _put(jobs / "failed" / job_id / "error.txt")
    return jobs / "failed" / job_id


def test_reset_removes_only_what_stemdeck_made(tmp_path: Path):
    jobs = tmp_path / "jobs"
    _registry.register(Job(id=SONG, status="done", title="Song"))
    ours = [
        _put(jobs / SONG / "stems" / "vocals.wav"),
        _put(jobs / "b1b2c3d4e5f6" / "source.mp3"),
        _quarantine(jobs, "c1b2c3d4e5f6"),
        _put(jobs / "registry.json"),
        _put(jobs / "registry.json.bad-20261101-120000-abc123"),
        _put(jobs / f".registry.json.{uuid.uuid4().hex}.tmp"),
        _put(jobs / "setlists.json"),
        _put(jobs / "user-data.json"),
    ]
    theirs = [
        _put(jobs / "My Photos" / "beach.jpg"),
        _put(jobs / "notes.txt"),
        _put(jobs / "registry.json.bak"),
        _put(jobs / "0123456789ab" / "config.v2.json"),
        _put(jobs / "failed" / "d1b2c3d4e5f6" / "core.dump"),
        _put(jobs / "failed" / "torrent.iso"),
    ]

    assert _registry.reset_all(jobs) == []

    assert [p for p in ours if p.exists()] == []
    assert [p for p in theirs if not p.exists()] == []
    assert _registry.all_jobs() == {}


def test_the_failed_job_sweep_removes_only_quarantines(tmp_path: Path):
    quarantined = _quarantine(tmp_path, SONG)
    foreign = _put(tmp_path / "failed" / "b1b2c3d4e5f6" / "core.dump").parent
    for folder in (quarantined, foreign):
        os.utime(folder, (OLD, OLD))

    with patch("app.pipeline.collect.FAILED_TTL_SECONDS", 3600):
        sweep_failed_jobs(tmp_path)

    assert not quarantined.exists()
    assert foreign.is_dir()


@needs_symlinks
def test_the_failed_job_sweep_never_follows_a_linked_failed_folder(tmp_path: Path):
    outside = tmp_path / "outside"
    evidence = _quarantine(outside, SONG)
    os.utime(evidence, (OLD, OLD))
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    (jobs / "failed").symlink_to(outside / "failed", target_is_directory=True)

    with patch("app.pipeline.collect.FAILED_TTL_SECONDS", 3600):
        sweep_failed_jobs(jobs)

    assert evidence.is_dir()


@needs_symlinks
def test_the_section_workspace_sweep_never_follows_a_linked_song(tmp_path: Path):
    outside = tmp_path / "outside"
    workspace = outside / "stems" / f"{_WORK_PREFIX}abc"
    _put(workspace / "part.npy")
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    (jobs / SONG).symlink_to(outside, target_is_directory=True)

    sweep_orphaned_workspaces(jobs)

    assert workspace.is_dir()
