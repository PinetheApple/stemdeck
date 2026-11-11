"""POST /api/jobs/{id}/audio-tags writes only what it newly found.

The page asks this when it opens a track that is missing tags, so opening a
song must leave its stored data alone unless the lookup found something the
job did not have. Each test counts the registry persists and metadata.json
writes a call made, and which files under the jobs dir it touched.
"""

from __future__ import annotations

from pathlib import Path
from typing import NamedTuple
from unittest.mock import patch

import pytest

import app.api.jobs as jobs_mod
from app.core.config import LYRICS_CANDIDATES_FILE
from app.core.models import Job
from tests.test_audio_tags_api import (  # noqa: F401
    _done_job,
    _isolate_registry,
    _tags_identity,
    client,
)

FOUND_TAGS = {"artist": "Nirvana", "title": "Lithium"}
UNTAGGED_UPLOAD = "local:Lithium"
FLAC_MAGIC = b"fLaC"
METADATA_FILE = "metadata.json"


class Writes(NamedTuple):
    persists: int
    metadata: int


NO_WRITES = Writes(persists=0, metadata=0)


def _done_upload(**fields) -> Job:
    job = _done_job(source_url=UNTAGGED_UPLOAD, **fields)
    job_dir = jobs_mod.JOBS_DIR / job.id
    (job_dir / "source.flac").write_bytes(FLAC_MAGIC)
    (job_dir / METADATA_FILE).write_text('{"title": "Lithium"}', encoding="utf-8")
    return job


def _snapshot(root: Path) -> dict[str, tuple[int, bytes]]:
    return {
        str(path.relative_to(root)): (path.stat().st_mtime_ns, path.read_bytes())
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _post_counting_writes(http, job_id: str) -> Writes:
    """Call the route once; the registry persists and metadata writes it made."""
    with (
        patch("app.api.jobs.registry_persist", wraps=jobs_mod.registry_persist) as persist,
        patch(
            "app.api.jobs._write_metadata_fields",
            wraps=jobs_mod._write_metadata_fields,
        ) as metadata,
    ):
        response = http.post(f"/api/jobs/{job_id}/audio-tags")
    assert response.status_code == 200
    return Writes(persists=persist.call_count, metadata=metadata.call_count)


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
    client,  # noqa: F811
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

    assert writes == NO_WRITES
    assert _snapshot(jobs_mod.JOBS_DIR) == before


def test_a_first_call_that_finds_no_lyrics_writes_only_the_not_found_stamp(
    client,  # noqa: F811
    monkeypatch,
):
    job = _done_upload(
        audio_tags=dict(FOUND_TAGS),
        identity=_tags_identity(FOUND_TAGS["artist"], FOUND_TAGS["title"]),
    )
    monkeypatch.setattr("app.pipeline.lyrics_lookup._fetch_json", _lrclib_has_nothing)
    before = _snapshot(jobs_mod.JOBS_DIR)

    writes = _post_counting_writes(client, job.id)

    after = _snapshot(jobs_mod.JOBS_DIR)
    assert writes == NO_WRITES
    changed = {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}
    assert changed == {f"{job.id}/{LYRICS_CANDIDATES_FILE}"}


def test_a_call_that_finds_new_tags_writes_them_once(client):  # noqa: F811
    job = _done_upload()
    with patch("app.api.jobs.probe_tags", return_value=dict(FOUND_TAGS)):
        first = _post_counting_writes(client, job.id)
        second = _post_counting_writes(client, job.id)

    assert first == Writes(persists=1, metadata=1)
    assert second == NO_WRITES
    assert job.audio_tags == FOUND_TAGS
    meta = (jobs_mod.JOBS_DIR / job.id / METADATA_FILE).read_text(encoding="utf-8")
    assert '"audio_tags"' in meta
