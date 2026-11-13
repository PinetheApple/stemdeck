"""An import the process died during twice is a failed import like any other:
kept with its source and reason across restarts, retryable from its row, and
recorded at startup without deleting anything."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import config
from app.core import registry as _registry
from app.core.config import DEMUCS_MODEL
from app.core.models import STATUS_ERROR, Job
from app.core.registry import _jobs
from app.core.registry import persist as persist_registry
from app.core.registry import restore as restore_registry
from app.core.song_folder import FAILED_DIR_NAME
from app.main import app
from app.pipeline import jobqueue

UPLOAD_ID = "abcdef300001"
LINK_ID = "abcdef300002"
LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
SOURCE = b"ID3upload"
PARTIAL_STEM = b"partial"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    _registry._pending_resume.clear()
    yield
    _jobs.clear()
    _registry._pending_resume.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _interrupted_twice(job_id: str, source_url: str, **fields: object) -> Job:
    """A job saved mid-separation after its second start, its folder as the
    killed run left it."""
    job = Job(
        id=job_id,
        status="separating",
        title="Poison",
        source_url=source_url,
        resume_attempts=_registry._MAX_RESUME_ATTEMPTS + 1,
        **fields,
    )
    job_dir = config.JOBS_DIR / job_id
    (job_dir / DEMUCS_MODEL).mkdir(parents=True)
    (job_dir / DEMUCS_MODEL / "vocals.wav").write_bytes(PARTIAL_STEM)
    if source_url.startswith("local:"):
        (job_dir / "source.mp3").write_bytes(SOURCE)
    _jobs[job.id] = job
    persist_registry(config.JOBS_DIR)
    return job


def _upload() -> Job:
    return _interrupted_twice(
        UPLOAD_ID, "local:Poison", source_name="Poison.mp3", source_format="mp3"
    )


def _link() -> Job:
    return _interrupted_twice(LINK_ID, LINK)


def _restart() -> None:
    _jobs.clear()
    restore_registry(config.JOBS_DIR)


def _file_contents(root: Path) -> list[bytes]:
    return sorted(p.read_bytes() for p in root.rglob("*") if p.is_file())


@pytest.mark.parametrize(
    ("make", "kind"),
    [(_upload, "file"), (_link, "link")],
)
def test_shows_as_a_retryable_failed_import(client: TestClient, make, kind: str) -> None:
    job = make()

    _restart()
    first = client.get(f"/api/jobs/{job.id}").json()
    persist_registry(config.JOBS_DIR)
    _restart()
    second = client.get(f"/api/jobs/{job.id}").json()

    for state in (first, second):
        assert (state["status"], state["source_kind"]) == (STATUS_ERROR, kind)
        assert state["source_url"] == job.source_url
        assert "twice" in state["error"]
        assert state["retryable"] is True
    assert _registry.take_pending_resume() == []


def test_retry_runs_the_upload_again_from_its_file(client: TestClient) -> None:
    _upload()
    _restart()
    persist_registry(config.JOBS_DIR)
    _restart()

    res = client.post(f"/api/jobs/{UPLOAD_ID}/retry")

    assert (res.status_code, res.json()["status"]) == (200, "queued")
    assert (config.JOBS_DIR / UPLOAD_ID / "source.mp3").read_bytes() == SOURCE
    assert jobqueue.snapshot() == (None, [UPLOAD_ID])


def test_retry_fetches_the_link_again(client: TestClient) -> None:
    _link()
    _restart()
    persist_registry(config.JOBS_DIR)
    _restart()

    res = client.post(f"/api/jobs/{LINK_ID}/retry")

    assert (res.status_code, res.json()["source_url"]) == (200, LINK)
    assert jobqueue.snapshot() == (None, [LINK_ID])


def test_nothing_is_deleted_when_the_failure_is_recorded() -> None:
    _upload()
    _link()
    before = _file_contents(config.JOBS_DIR / UPLOAD_ID) + _file_contents(config.JOBS_DIR / LINK_ID)

    _restart()

    failed = config.JOBS_DIR / FAILED_DIR_NAME
    after = _file_contents(failed / UPLOAD_ID) + _file_contents(failed / LINK_ID)
    assert all(after.count(content) >= before.count(content) for content in before)
