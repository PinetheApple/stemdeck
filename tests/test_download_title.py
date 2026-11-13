from __future__ import annotations

from pathlib import Path

import pytest

from app.core.models import Job
from app.pipeline import download as dl_mod


class _UntitledYDL:
    """A source whose metadata carries no title."""

    def __init__(self, opts):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def extract_info(self, url, download=False):
        return {"duration": 10}


@pytest.fixture(autouse=True)
def _untitled(monkeypatch):
    monkeypatch.setattr(dl_mod, "YoutubeDL", _UntitledYDL)
    monkeypatch.setattr(dl_mod, "bundled_js_runtime", lambda: None)
    monkeypatch.setattr(dl_mod, "get_cookies_file", lambda: None)


def test_a_source_without_a_title_keeps_the_title_the_job_was_queued_with(tmp_path: Path):
    job = Job(id="abcdefabc036", title="Build My Life")
    (tmp_path / "source.webm").write_bytes(b"x")
    dl_mod.download(job, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", tmp_path)
    assert job.title == "Build My Life"
