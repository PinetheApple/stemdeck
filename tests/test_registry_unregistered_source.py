"""A song stopped before it was separated survives a lost registry
(upstream PR 889, #88).

Such a song keeps its source file and nothing else, and for an upload that
file is the only copy StemDeck has. restore() rebuilt only folders with stems,
so the song left the library with registry.json and Extract could not reach it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.core import registry as _registry
from app.core.config import STEM_NAMES
from app.core.registry import is_upload, registry_path

JOB = "a1b2c3d4e5f6"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()


def _folder(root: Path, *names: str) -> Path:
    job_dir = root / JOB
    job_dir.mkdir()
    for name in names:
        (job_dir / name).write_bytes(b"audio")
    return job_dir


def test_a_stopped_upload_comes_back_as_a_stopped_song(tmp_path: Path):
    _folder(tmp_path, "source.flac")

    _registry.restore(tmp_path)

    job = _registry.get(JOB)
    assert job.status == "stopped"
    assert is_upload(job)
    assert job.source_format == "flac"
    assert job.selected_stems == list(STEM_NAMES)
    assert job.title == f"Recovered track {JOB[:6]}"
    saved = json.loads(registry_path(tmp_path).read_text(encoding="utf-8"))["jobs"]
    assert [r["id"] for r in saved] == [JOB]


def test_extract_finds_the_source_it_kept(tmp_path: Path):
    from app.pipeline.jobqueue import _find_local_source

    job_dir = _folder(tmp_path, "source.mp3")

    _registry.restore(tmp_path)

    assert _registry.get(JOB) is not None
    assert _find_local_source(job_dir) == job_dir / "source.mp3"


@pytest.mark.parametrize("names", [("source.webm.part",), ("source.webm",), ("metadata.json",)])
def test_a_folder_without_an_upload_source_is_not_adopted(tmp_path: Path, names):
    _folder(tmp_path, *names)

    _registry.restore(tmp_path)

    assert _registry.get(JOB) is None


def test_a_deleted_song_is_not_brought_back(tmp_path: Path):
    _folder(tmp_path, "source.mp3")
    registry_path(tmp_path).write_text(
        json.dumps({"version": 2, "jobs": [], "deleted": [JOB]}), encoding="utf-8"
    )

    _registry.restore(tmp_path)

    assert _registry.get(JOB) is None


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")
def test_a_folder_holding_a_link_is_not_adopted(tmp_path: Path):
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"audio")
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    (jobs / JOB).mkdir()
    (jobs / JOB / "source.mp3").symlink_to(outside)

    _registry.restore(jobs)

    assert _registry.get(JOB) is None
