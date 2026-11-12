"""A failed import keeps what a retry needs, beside its failure evidence.

The quarantine used to strip every audio file, so a failed upload could only be
imported again by finding the file, and a failed job of either kind was gone
after a restart: failed jobs are not in the registry file. jobs/failed/<id>
now also holds the job's record and, for an upload, the uploaded file.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.models import Job
from app.pipeline.errors import CAUSE_OUT_OF_MEMORY, SeparationError
from app.pipeline.runner import FAILED_RECORD_FILE, run_local_pipeline, run_pipeline

LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def _out_of_memory(*args, **kwargs):
    raise SeparationError("demucs failed", tail=["CUDA out of memory"], device="cuda")


@pytest.mark.asyncio
async def test_a_failed_upload_keeps_its_file_and_record(tmp_path: Path) -> None:
    job = Job(id="abcdef100001", source_url="local:Song", source_name="Song.mp3")
    job_dir = tmp_path / job.id
    (job_dir / "stems").mkdir(parents=True)
    source = job_dir / "source.mp3"
    source.write_bytes(b"ID3")
    (job_dir / "video.mp4").write_bytes(b"mp4")

    with patch("app.pipeline.runner._run_local_blocking", side_effect=_out_of_memory):
        await run_local_pipeline(job, source, tmp_path)

    quarantined = tmp_path / "failed" / job.id
    assert job.error_code == CAUSE_OUT_OF_MEMORY
    assert (quarantined / "source.mp3").read_bytes() == b"ID3"
    assert (quarantined / "video.mp4").is_file()
    assert not (quarantined / "stems").exists()
    record = json.loads((quarantined / FAILED_RECORD_FILE).read_text(encoding="utf-8"))
    assert record["status"] == "error"
    assert record["error_code"] == CAUSE_OUT_OF_MEMORY
    assert record["source_name"] == "Song.mp3"


@pytest.mark.asyncio
async def test_a_failed_link_keeps_its_record_but_no_audio(tmp_path: Path) -> None:
    job = Job(id="abcdef100002", source_url=LINK)

    def fail_with_a_download(job: Job, url: str, job_dir: Path) -> None:
        (job_dir / "source.webm").write_bytes(b"audio")
        raise RuntimeError("ERROR: Video unavailable")

    with patch("app.pipeline.runner._run_blocking", side_effect=fail_with_a_download):
        await run_pipeline(job, LINK, tmp_path)

    quarantined = tmp_path / "failed" / job.id
    assert job.error_code == "source-unavailable"
    assert not list(quarantined.glob("source.*"))
    record = json.loads((quarantined / FAILED_RECORD_FILE).read_text(encoding="utf-8"))
    assert record["source_url"] == LINK
