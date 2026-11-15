"""Auto-delete keeps a song that holds the user's recorded takes."""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path

import pytest

from app.core.models import Job
from app.core.registry import _jobs
from app.core.takes_config import AUDIO_PART_FILE, SIDECAR_FILE, TAKES_DIRNAME
from app.pipeline.collect import sweep_old_jobs

TTL_SEC = 60
LONG_AGO_SEC = 999_999


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


def _old_done_job(jobs_dir: Path, job_id: str) -> Path:
    folder = jobs_dir / job_id
    (folder / "stems").mkdir(parents=True)
    job = Job(id=job_id, status="done")
    job.created_at = time.time() - LONG_AGO_SEC
    _jobs[job.id] = job
    return folder


def _take(folder: Path, name: str, data: bytes) -> None:
    take = folder / TAKES_DIRNAME / "t0000000a"
    take.mkdir(parents=True)
    (take / name).write_bytes(data)


def test_keeps_an_old_song_with_a_finished_take(tmp_path, caplog):
    kept = _old_done_job(tmp_path, "abcdefabcd01")
    _take(kept, SIDECAR_FILE, b"{}")
    swept = _old_done_job(tmp_path, "abcdefabcd02")
    with caplog.at_level(logging.INFO, logger="stemdeck.collect"):
        sweep_old_jobs(tmp_path, ttl_seconds=TTL_SEC)
    assert kept.is_dir() and kept.name in _jobs
    assert not swept.exists() and swept.name not in _jobs
    assert "auto-delete kept abcdefabcd01: has takes" in caplog.text


def test_keeps_an_old_song_with_only_a_take_being_recorded(tmp_path):
    kept = _old_done_job(tmp_path, "abcdefabcd03")
    _take(kept, AUDIO_PART_FILE, b"\0" * 8)
    sweep_old_jobs(tmp_path, ttl_seconds=TTL_SEC)
    assert kept.is_dir()


def test_sweeps_an_old_song_whose_take_received_nothing(tmp_path):
    swept = _old_done_job(tmp_path, "abcdefabcd04")
    _take(swept, AUDIO_PART_FILE, b"")
    sweep_old_jobs(tmp_path, ttl_seconds=TTL_SEC)
    assert not swept.exists()


def test_keeps_an_unregistered_folder_with_takes(tmp_path):
    folder = tmp_path / "abcdefabcd05"
    folder.mkdir()
    (folder / "metadata.json").write_text("{}", encoding="utf-8")
    _take(folder, SIDECAR_FILE, b"{}")
    old = time.time() - LONG_AGO_SEC
    os.utime(folder, (old, old))
    sweep_old_jobs(tmp_path, ttl_seconds=TTL_SEC)
    assert folder.is_dir()
