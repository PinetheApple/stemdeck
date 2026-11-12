"""Where a song came from, and running a failed import again as the same job,
also after a restart, when the job is read back from its failure record."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import jobs as jobs_mod
from app.api.jobs import RESTORE_FROM_TRASH_FIRST, SOURCE_FILE_GONE
from app.core import config
from app.core.models import STATUS_DONE, STATUS_ERROR, Job
from app.core.registry import _jobs, register
from app.core.song_folder import FAILED_DIR_NAME
from app.main import app
from app.pipeline import jobqueue
from app.pipeline.errors import CAUSE_OUT_OF_MEMORY
from app.pipeline.runner import FAILED_RECORD_FILE

LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
UPLOAD_ID = "abcdef200001"
LINK_ID = "abcdef200002"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _failed_dir(job_id: str) -> Path:
    return config.JOBS_DIR / FAILED_DIR_NAME / job_id


def _failed(job_id: str, source_url: str, **fields: object) -> Job:
    job = Job(
        id=job_id,
        status=STATUS_ERROR,
        source_url=source_url,
        error="Audio processing failed. Please try again.",
        error_detail=f"{CAUSE_OUT_OF_MEMORY} — CUDA out of memory",
        error_code=CAUSE_OUT_OF_MEMORY,
        **fields,
    )
    quarantined = _failed_dir(job_id)
    quarantined.mkdir(parents=True)
    (quarantined / FAILED_RECORD_FILE).write_text(json.dumps(job.to_record()), encoding="utf-8")
    return job


def _failed_upload(*, keep_file: bool = True) -> Job:
    job = _failed(UPLOAD_ID, "local:Song", source_name="Song.mp3", source_format="mp3")
    if keep_file:
        (_failed_dir(UPLOAD_ID) / "source.mp3").write_bytes(b"ID3")
    return job


def test_state_says_where_a_song_came_from(client: TestClient) -> None:
    register(_failed_upload())
    register(_failed(LINK_ID, LINK))

    upload = client.get(f"/api/jobs/{UPLOAD_ID}").json()
    link = client.get(f"/api/jobs/{LINK_ID}").json()

    assert (upload["source_kind"], upload["source_name"]) == ("file", "Song.mp3")
    assert (link["source_kind"], link["source_url"]) == ("link", LINK)
    assert upload["error_code"] == link["error_code"] == CAUSE_OUT_OF_MEMORY
    assert upload["retryable"] is True and link["retryable"] is True


def test_a_failed_upload_whose_file_is_gone_is_not_retryable(client: TestClient) -> None:
    register(_failed_upload(keep_file=False))

    assert client.get(f"/api/jobs/{UPLOAD_ID}").json()["retryable"] is False
    res = client.post(f"/api/jobs/{UPLOAD_ID}/retry")

    assert res.status_code == 410
    assert res.json()["detail"] == SOURCE_FILE_GONE


def test_retry_queues_the_same_upload_from_its_kept_file(client: TestClient) -> None:
    job = _failed_upload()
    register(job)

    res = client.post(f"/api/jobs/{UPLOAD_ID}/retry")

    assert res.status_code == 200
    body = res.json()
    assert (body["job_id"], body["status"], body["error_code"]) == (UPLOAD_ID, "queued", None)
    assert body["error_detail"] is None
    assert (config.JOBS_DIR / UPLOAD_ID / "source.mp3").read_bytes() == b"ID3"
    assert not _failed_dir(UPLOAD_ID).exists()
    assert jobqueue.snapshot() == (None, [UPLOAD_ID])
    assert list(_jobs) == [UPLOAD_ID]


def test_retry_after_a_restart_reads_the_failure_record(client: TestClient) -> None:
    _failed(LINK_ID, LINK)

    assert client.get(f"/api/jobs/{LINK_ID}").json()["status"] == STATUS_ERROR
    res = client.post(f"/api/jobs/{LINK_ID}/retry")

    assert res.status_code == 200
    assert res.json()["source_url"] == LINK
    assert jobqueue.snapshot() == (None, [LINK_ID])


def test_retry_refuses_a_job_that_has_not_failed(client: TestClient) -> None:
    register(Job(id=LINK_ID, status=STATUS_DONE, source_url=LINK))
    res = client.post(f"/api/jobs/{LINK_ID}/retry")
    assert (res.status_code, res.json()["detail"]) == (409, "job has not failed")


def test_retry_refuses_a_failed_job_in_the_trash(client: TestClient) -> None:
    job = _failed(LINK_ID, LINK)
    job.trashed_at = 1.0
    register(job)
    assert client.post(f"/api/jobs/{LINK_ID}/retry").status_code == 409
    assert job.status == STATUS_ERROR


def test_retry_of_an_unknown_job_is_not_found(client: TestClient) -> None:
    assert client.post(f"/api/jobs/{LINK_ID}/retry").status_code == 404
    assert client.post("/api/jobs/not-an-id/retry").status_code == 404


def test_delete_after_a_restart_removes_the_kept_file(client: TestClient) -> None:
    _failed_upload()

    assert client.delete(f"/api/jobs/{UPLOAD_ID}").status_code == 200

    assert not _failed_dir(UPLOAD_ID).exists()
    assert client.get(f"/api/jobs/{UPLOAD_ID}").status_code == 404


def test_an_upload_records_its_original_file_name(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(jobs_mod, "_probe_duration", lambda path: 60.0)
    monkeypatch.setattr(jobs_mod.jobqueue, "enqueue", lambda job_id: None)
    res = client.post(
        "/api/jobs",
        files={"file": ("My  Song.final.mp3", b"ID3data", "audio/mpeg")},
    )

    state = client.get(f"/api/jobs/{res.json()['job_id']}").json()
    assert state["source_name"] == "My  Song.final.mp3"
    assert state["source_kind"] == "file"


def test_trash_and_restore_work_after_a_restart(client: TestClient) -> None:
    _failed(LINK_ID, LINK)

    assert client.post(f"/api/jobs/{LINK_ID}/trash").status_code == 200
    _jobs.clear()
    assert client.post(f"/api/jobs/{LINK_ID}/restore").status_code == 200


def test_a_trashed_failed_job_stays_in_the_trash_after_a_restart(client: TestClient) -> None:
    _failed(LINK_ID, LINK)
    client.post(f"/api/jobs/{LINK_ID}/trash")
    _jobs.clear()

    res = client.post(f"/api/jobs/{LINK_ID}/retry")

    assert (res.status_code, res.json()["detail"]) == (409, RESTORE_FROM_TRASH_FIRST)
    assert client.get(f"/api/jobs/{LINK_ID}").json()["trashed_at"] is not None


def test_a_reimport_replaces_a_failed_job_across_a_restart(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(jobs_mod.jobqueue, "enqueue", lambda job_id: None)
    _failed(LINK_ID, LINK)

    res = client.post("/api/jobs", json={"url": LINK, "replaces": LINK_ID})
    new = _jobs[res.json()["job_id"]]
    assert new.replaces == LINK_ID
    _jobs.clear()
    register(new)
    new.status = STATUS_DONE
    jobs_mod._apply_replacement(new)

    assert not _failed_dir(LINK_ID).exists()
    assert client.get(f"/api/jobs/{LINK_ID}").status_code == 404
