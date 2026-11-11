"""POST /api/jobs/{id}/audio-tags writes only what it newly found.

The page asks this every time it opens a track that is missing tags, so
opening a song must leave its stored data alone unless the lookup found
something the job did not have. Each test here calls the route, then checks
what a second call with nothing new to find wrote: no registry persist, no
metadata.json write, and no file under the jobs dir touched.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.api.jobs as jobs_mod
from app.core.models import Job
from app.core.registry import _jobs

FOUND_TAGS = {"artist": "Nirvana", "title": "Lithium"}
UNTAGGED_UPLOAD = "local:Lithium"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    jobs_mod._TAG_LOOKUPS.clear()
    yield
    _jobs.clear()
    jobs_mod._TAG_LOOKUPS.clear()


@pytest.fixture
def client():
    with patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None):
        from app.main import app

        with TestClient(app) as c:
            yield c


def _done_upload(**fields) -> Job:
    job = Job(
        id="aaaaaaaaaaaa",
        status="done",
        title="Lithium",
        source_url=UNTAGGED_UPLOAD,
        **fields,
    )
    _jobs[job.id] = job
    job_dir = jobs_mod.JOBS_DIR / job.id
    (job_dir / "stems").mkdir(parents=True)
    (job_dir / "source.flac").write_bytes(b"fLaC")
    (job_dir / "metadata.json").write_text('{"title": "Lithium"}', encoding="utf-8")
    return job


def _snapshot(root: Path) -> dict[str, tuple[int, bytes]]:
    return {
        str(path.relative_to(root)): (path.stat().st_mtime_ns, path.read_bytes())
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _post_counting_writes(client, job_id: str) -> tuple[int, int]:
    """Call the route once; how many registry persists and metadata writes it made."""
    with (
        patch("app.api.jobs.registry_persist", wraps=jobs_mod.registry_persist) as persist,
        patch(
            "app.api.jobs._write_metadata_fields",
            wraps=jobs_mod._write_metadata_fields,
        ) as metadata,
    ):
        response = client.post(f"/api/jobs/{job_id}/audio-tags")
    assert response.status_code == 200
    return persist.call_count, metadata.call_count


def _lrclib_has_nothing(endpoint, params):
    return []


@pytest.mark.parametrize(
    ("tags", "probed", "lrclib"),
    [
        pytest.param(None, None, None, id="no-tags-found"),
        pytest.param(dict(FOUND_TAGS), None, None, id="tags-band-unfindable"),
        pytest.param(dict(FOUND_TAGS), None, _lrclib_has_nothing, id="lrclib-has-nothing"),
        pytest.param(None, dict(FOUND_TAGS), None, id="tags-found-first-call"),
    ],
)
def test_a_second_call_with_nothing_new_writes_nothing(
    client,
    monkeypatch,
    tags,
    probed,
    lrclib,
):
    job = _done_upload(audio_tags=tags)
    if lrclib is not None:
        monkeypatch.setattr("app.pipeline.lyrics_lookup._fetch_json", lrclib)
    with patch("app.api.jobs.probe_tags", return_value=probed):
        client.post(f"/api/jobs/{job.id}/audio-tags")
        before = _snapshot(jobs_mod.JOBS_DIR)
        writes = _post_counting_writes(client, job.id)

    assert writes == (0, 0)
    assert _snapshot(jobs_mod.JOBS_DIR) == before


def test_a_call_that_finds_new_tags_writes_them_once(client):
    job = _done_upload()
    with patch("app.api.jobs.probe_tags", return_value=dict(FOUND_TAGS)):
        first = _post_counting_writes(client, job.id)
        second = _post_counting_writes(client, job.id)

    assert first == (1, 1)
    assert second == (0, 0)
    assert job.audio_tags == FOUND_TAGS
    meta = (jobs_mod.JOBS_DIR / job.id / "metadata.json").read_text(encoding="utf-8")
    assert '"audio_tags"' in meta
