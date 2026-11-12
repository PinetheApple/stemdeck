"""A failed import keeps its record, and an upload its own file, so it can be
retried, also after a restart."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.models import STATUS_ERROR, Job
from app.core.song_folder import FAILED_DIR_NAME
from app.pipeline import runner
from app.pipeline.errors import (
    CAUSE_OUT_OF_MEMORY,
    CAUSE_SOURCE_UNAVAILABLE,
    CAUSE_UNKNOWN,
    SeparationError,
)
from app.pipeline.runner import (
    FAILED_RECORD_FILE,
    UPLOAD_VIDEO_FILE,
    run_local_pipeline,
    run_pipeline,
)

LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
UPLOAD_SOURCE = "source.mp3"


def _out_of_memory(*args, **kwargs):
    raise SeparationError("demucs failed", tail=["CUDA out of memory"], device="cuda")


def _failed_upload(tmp_path: Path) -> tuple[Job, Path]:
    job = Job(id="abcdef100001", source_url="local:Song", source_name="Song.mp3")
    job_dir = tmp_path / job.id
    (job_dir / "stems").mkdir(parents=True)
    source = job_dir / UPLOAD_SOURCE
    source.write_bytes(b"ID3")
    (job_dir / UPLOAD_VIDEO_FILE).write_bytes(b"mp4")
    return job, source


@pytest.mark.asyncio
async def test_a_failed_upload_keeps_its_file_and_record(tmp_path: Path) -> None:
    job, source = _failed_upload(tmp_path)

    with patch("app.pipeline.runner._run_local_blocking", side_effect=_out_of_memory):
        await run_local_pipeline(job, source, tmp_path)

    quarantined = tmp_path / FAILED_DIR_NAME / job.id
    assert job.error_code == CAUSE_OUT_OF_MEMORY
    assert (quarantined / UPLOAD_SOURCE).read_bytes() == b"ID3"
    assert (quarantined / UPLOAD_VIDEO_FILE).is_file()
    assert not (quarantined / "stems").exists()
    record = json.loads((quarantined / FAILED_RECORD_FILE).read_text(encoding="utf-8"))
    assert record["status"] == STATUS_ERROR
    assert record["error_code"] == CAUSE_OUT_OF_MEMORY
    assert record["source_name"] == "Song.mp3"


@pytest.mark.asyncio
async def test_the_error_is_published_once_the_failure_is_kept(tmp_path: Path) -> None:
    """A state read as soon as the job shows failed already has its cause and
    its kept file, so it reads as retryable with the right reason."""
    job, source = _failed_upload(tmp_path)
    kept = tmp_path / FAILED_DIR_NAME / job.id / UPLOAD_SOURCE
    at_publish: list[tuple[str | None, bool]] = []
    real_set = runner._set

    def watch(target: Job, **fields: object) -> None:
        real_set(target, **fields)
        if target.status == STATUS_ERROR and not at_publish:
            at_publish.append((target.error_code, kept.is_file()))

    with (
        patch("app.pipeline.runner._run_local_blocking", side_effect=_out_of_memory),
        patch("app.pipeline.runner._set", side_effect=watch),
    ):
        await run_local_pipeline(job, source, tmp_path)

    assert at_publish == [(CAUSE_OUT_OF_MEMORY, True)]


@pytest.mark.asyncio
async def test_a_failed_link_keeps_its_record_but_no_audio(tmp_path: Path) -> None:
    job = Job(id="abcdef100002", source_url=LINK)

    def fail_with_a_download(job: Job, url: str, job_dir: Path) -> None:
        (job_dir / "source.webm").write_bytes(b"audio")
        raise RuntimeError("ERROR: Video unavailable")

    with patch("app.pipeline.runner._run_blocking", side_effect=fail_with_a_download):
        await run_pipeline(job, LINK, tmp_path)

    quarantined = tmp_path / FAILED_DIR_NAME / job.id
    assert job.error_code == CAUSE_SOURCE_UNAVAILABLE
    assert not list(quarantined.glob("source.*"))
    record = json.loads((quarantined / FAILED_RECORD_FILE).read_text(encoding="utf-8"))
    assert record["source_url"] == LINK


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "step",
    ["app.pipeline.runner.classify_failure", "app.pipeline.runner.release_source"],
)
async def test_the_job_shows_failed_even_when_recording_the_failure_breaks(
    tmp_path: Path,
    step: str,
) -> None:
    job, source = _failed_upload(tmp_path)

    with (
        patch("app.pipeline.runner._run_local_blocking", side_effect=_out_of_memory),
        patch(step, side_effect=RuntimeError("broken step")),
    ):
        await run_local_pipeline(job, source, tmp_path)

    assert job.status == STATUS_ERROR
    assert job.error_code in (CAUSE_UNKNOWN, CAUSE_OUT_OF_MEMORY)


@pytest.mark.asyncio
async def test_a_trash_while_the_failure_is_kept_reaches_the_record(tmp_path: Path) -> None:
    job, source = _failed_upload(tmp_path)
    real_keep = runner._kept_for_retry

    def trashed_meanwhile(target: Job, job_dir: Path) -> frozenset[str]:
        target.trashed_at = 1.0
        return real_keep(target, job_dir)

    with (
        patch("app.pipeline.runner._run_local_blocking", side_effect=_out_of_memory),
        patch("app.pipeline.runner._kept_for_retry", side_effect=trashed_meanwhile),
    ):
        await run_local_pipeline(job, source, tmp_path)

    record_path = tmp_path / FAILED_DIR_NAME / job.id / FAILED_RECORD_FILE
    assert json.loads(record_path.read_text(encoding="utf-8"))["trashed_at"] == 1.0
