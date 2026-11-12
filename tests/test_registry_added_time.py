"""A song rebuilt from its folder keeps the time it was added
(upstream PR 1005, #88).

The library is ordered by created_at. A song with no metadata.json, one
stopped before it was separated or cut off part way, was rebuilt with the
folder's own time, which moves with every file written into it, so the song
jumped to the end of the list.
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.api.jobs as jobs_mod
from app.core import registry as _registry
from app.core.models import Job
from app.core.registry import registry_path
from app.core.song_folder import STEMS_COMPLETE, keep_added_time
from app.pipeline.runner import run_pipeline

JOB = "a1b2c3d4e5f6"
ADDED = 1_700_000_000.0
LATER = ADDED + 86_400


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()


def _meta(job_dir: Path) -> dict:
    return json.loads((job_dir / "metadata.json").read_text(encoding="utf-8"))


def _touch(job_dir: Path) -> None:
    os.utime(job_dir, (LATER, LATER))


def test_a_stopped_song_rebuilt_from_its_folder_keeps_its_place(tmp_path: Path):
    job_dir = tmp_path / JOB
    job_dir.mkdir()
    (job_dir / "source.mp3").write_bytes(b"ID3")
    keep_added_time(Job(id=JOB, created_at=ADDED), job_dir)
    _touch(job_dir)

    _registry.restore(tmp_path)

    assert _registry.get(JOB).status == "stopped"
    assert _registry.get(JOB).created_at == ADDED


def test_the_added_time_does_not_make_a_cut_off_separation_done(tmp_path: Path):
    job_dir = tmp_path / JOB
    (job_dir / "stems").mkdir(parents=True)
    (job_dir / "stems" / "vocals.wav").write_bytes(b"RIFF")
    keep_added_time(Job(id=JOB, created_at=ADDED), job_dir)

    _registry.restore(tmp_path)

    assert _registry.get(JOB) is None


def test_a_finished_song_without_its_metadata_keeps_the_added_time(tmp_path: Path):
    job_dir = tmp_path / JOB
    (job_dir / "stems").mkdir(parents=True)
    (job_dir / "stems" / "vocals.wav").write_bytes(b"RIFF")
    (job_dir / "stems" / STEMS_COMPLETE).write_text("", encoding="utf-8")
    keep_added_time(Job(id=JOB, created_at=ADDED), job_dir)
    _touch(job_dir)

    _registry.restore(tmp_path)

    job = _registry.get(JOB)
    assert job.status == "done"
    assert job.created_at == ADDED
    assert job.title == f"Recovered track {JOB[:6]}"
    assert _meta(job_dir) == {"created_at": ADDED, "title": job.title}


def test_the_added_time_never_replaces_a_metadata_file(tmp_path: Path):
    job_dir = tmp_path / JOB
    job_dir.mkdir()
    (job_dir / "metadata.json").write_text(json.dumps({"title": "T"}), encoding="utf-8")

    keep_added_time(Job(id=JOB, created_at=ADDED), job_dir)

    assert _meta(job_dir) == {"title": "T"}


@pytest.mark.asyncio
async def test_a_run_keeps_the_added_time_before_it_writes_anything(tmp_path: Path):
    job = Job(id=JOB, created_at=ADDED)
    seen: list[dict] = []

    def run(job, url, job_dir):
        seen.append(_meta(job_dir))

    with patch("app.pipeline.runner._run_blocking", side_effect=run):
        await run_pipeline(job, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", tmp_path)

    assert seen == [{"created_at": ADDED}]


def test_an_upload_keeps_the_added_time_from_the_start(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(jobs_mod, "JOBS_DIR", tmp_path)
    with (
        patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None),
        patch("app.api.jobs._probe_duration", return_value=60.0),
    ):
        from app.main import app

        r = TestClient(app).post(
            "/api/jobs", files={"file": ("song.mp3", io.BytesIO(b"ID3audio"), "audio/mpeg")}
        )

    assert r.status_code == 200
    job = _registry.get(r.json()["job_id"])
    assert _meta(tmp_path / job.id) == {"created_at": job.created_at}


def test_a_resplit_keeps_its_own_added_time(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(jobs_mod, "JOBS_DIR", tmp_path)
    done = Job(id=JOB, status="done", title="Demo", source_url="local:Demo")
    _registry.register(done)
    (tmp_path / JOB / "stems").mkdir(parents=True)
    (tmp_path / JOB / "source.mp3").write_bytes(b"ID3")
    with patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None):
        from app.main import app

        r = TestClient(app).post(f"/api/jobs/{JOB}/resplit", json={"stems": ["vocals"]})

    assert r.status_code == 200
    new = _registry.get(r.json()["job_id"])
    assert _meta(tmp_path / new.id) == {"created_at": new.created_at}


def test_a_registry_save_keeps_the_record_over_the_folder(tmp_path: Path):
    job_dir = tmp_path / JOB
    job_dir.mkdir()
    (job_dir / "source.mp3").write_bytes(b"ID3")
    keep_added_time(Job(id=JOB, created_at=ADDED), job_dir)
    record = Job(id=JOB, status="stopped", title="Kept", created_at=LATER).to_record()
    registry_path(tmp_path).write_text(json.dumps({"version": 2, "jobs": [record]}))

    _registry.restore(tmp_path)

    assert _registry.get(JOB).created_at == LATER
