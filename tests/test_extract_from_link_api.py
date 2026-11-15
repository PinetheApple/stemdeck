"""POST .../versions/extract on a link song with no kept audio: the audio is
fetched again from its link into the run's temp folder, then separated. The
downloader and separator are stubbed; nothing touches the network."""

from __future__ import annotations

import threading
from pathlib import Path

import pytest
from yt_dlp.utils import DownloadError

import app.core.config as cfg
from app.api.versions import SOURCE_GONE
from app.core.models import STATUS_DONE, Job, JobCancelled, _set
from app.pipeline import extract_stems as ex_mod
from app.pipeline.errors import CAUSE_SOURCE_UNAVAILABLE
from app.pipeline.runs import CANCELLED, DONE, FAILED, IDLE, RUNNING
from tests.test_extract_stems_api import (
    CANCEL,
    EXTRACT,
    POLL_SEC,
    WAIT_SEC,
    FakeSeparator,
    _isolate,  # noqa: F401
    client,  # noqa: F401
    extract,
    snapshot,
    song,
    stub,
    temps,
    wait_ended,
)
from tests.test_versions_api import JOB_ID

LINK = "https://www.youtube.com/watch?v=aaaaaaaaaaa"
UPLOAD = "local:Song.wav"
DOWNLOADED = "source.webm"
DOWNLOAD_PROGRESS = 0.25
# What download() writes on the job it is given.
DOWNLOADER_STATUS = "downloading"
# yt-dlp's wording for a removed video.
DEAD_LINK = "ERROR: [youtube] aaaaaaaaaaa: Video unavailable. This video has been removed"


class RecordingSeparator(FakeSeparator):
    """FakeSeparator, remembering the audio it was given."""

    def __init__(self) -> None:
        super().__init__()
        self.sources: list[Path] = []

    def __call__(self, job: Job, source: Path, job_dir: Path) -> Path:
        self.sources.append(source)
        return super().__call__(job, source, job_dir)


class FakeDownloader:
    """download(): reports a quarter done, then waits for a release, failing
    with `error` or stopping as yt-dlp's progress hook does on a cancel."""

    def __init__(self, error: Exception | None = None):
        self.error = error
        self.release = threading.Event()
        self.started = threading.Event()
        self.calls: list[tuple[Job, str, Path]] = []
        self.options: list[dict] = []

    def __call__(self, job: Job, url: str, job_dir: Path, **kwargs) -> Path:
        self.calls.append((job, url, job_dir))
        self.options.append(kwargs)
        _set(job, status=DOWNLOADER_STATUS, progress=DOWNLOAD_PROGRESS)
        self.started.set()
        while not self.release.wait(POLL_SEC):
            if job.cancel_requested:
                raise JobCancelled()
        if self.error is not None:
            raise self.error
        audio = job_dir / DOWNLOADED
        audio.write_bytes(b"fetched audio")
        return audio


@pytest.fixture
def fetcher(monkeypatch):
    fake = FakeDownloader()
    monkeypatch.setattr(ex_mod, "download", fake)
    yield fake
    fake.release.set()


def link_song(*gone: str, source_url: str = LINK, kept: bool = False) -> Job:
    job = song(*gone, source=kept)
    job.source_url = source_url
    return job


def song_folder() -> dict[str, bytes]:
    folder = cfg.JOBS_DIR / JOB_ID
    return {
        str(p.relative_to(folder)): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()
    }


def test_a_link_song_downloads_then_separates(client, monkeypatch, fetcher):  # noqa: F811
    job = link_song("guitar")
    separator = stub(monkeypatch, FakeSeparator())

    r = extract(client)

    assert r.status_code == 202
    assert fetcher.started.wait(WAIT_SEC)
    view = client.get(EXTRACT).json()
    assert view["state"] == RUNNING
    assert view["phase"] == ex_mod.PHASE_DOWNLOADING
    assert view["progress"] == DOWNLOAD_PROGRESS
    assert job.status == STATUS_DONE
    fetcher.release.set()
    assert separator.started.wait(WAIT_SEC)
    assert client.get(EXTRACT).json()["phase"] == ex_mod.PHASE_SEPARATING
    separator.release.set()
    assert wait_ended(client)["state"] == DONE


def test_the_link_audio_is_fetched_into_the_runs_temp_and_not_kept(client, monkeypatch, fetcher):  # noqa: F811
    job = link_song("guitar")
    separator = stub(monkeypatch, RecordingSeparator())
    extract(client)
    fetcher.release.set()
    assert separator.started.wait(WAIT_SEC)
    separator.release.set()

    assert wait_ended(client)["state"] == DONE
    scratch, url, into = fetcher.calls[0]
    assert scratch is not job
    assert (scratch.id, url) == (JOB_ID, LINK)
    assert separator.dirs == [into]
    assert separator.sources == [into / DOWNLOADED]
    assert fetcher.options == [{"video": False}]
    assert into.parent == cfg.JOBS_DIR / JOB_ID / "stems"
    assert into.name.startswith(".")
    assert temps() == []
    assert not any(name.startswith("source") for name in song_folder())


def test_a_dead_link_fails_with_its_cause_and_leaves_the_song(client, monkeypatch, fetcher):  # noqa: F811
    job = link_song("guitar")
    before = song_folder()
    fetcher.error = DownloadError(DEAD_LINK)
    separator = stub(monkeypatch, FakeSeparator())
    extract(client)
    fetcher.release.set()

    view = wait_ended(client)

    assert view["state"] == FAILED
    assert view["error"] == CAUSE_SOURCE_UNAVAILABLE
    assert separator.jobs == []
    assert song_folder() == before
    assert (job.status, job.versions) == (STATUS_DONE, None)


def test_cancel_during_the_download_stops_it_and_leaves_nothing(client, monkeypatch, fetcher):  # noqa: F811
    job = link_song("guitar")
    before = snapshot()
    separator = stub(monkeypatch, FakeSeparator())
    extract(client)
    assert fetcher.started.wait(WAIT_SEC)

    assert client.post(CANCEL).status_code == 200

    assert wait_ended(client)["state"] == CANCELLED
    assert separator.jobs == []
    assert snapshot() == before
    assert temps() == []
    assert (job.status, job.versions) == (STATUS_DONE, None)


def test_an_upload_without_its_audio_is_still_refused(client, monkeypatch, fetcher):  # noqa: F811
    link_song("guitar", source_url=UPLOAD)

    r = extract(client)

    assert r.status_code == 409
    assert r.json()["detail"] == SOURCE_GONE
    assert client.get(EXTRACT).json() == {"state": IDLE}
    assert fetcher.calls == []


def test_kept_audio_is_separated_without_a_download(client, monkeypatch, fetcher):  # noqa: F811
    link_song("guitar", kept=True)
    separator = stub(monkeypatch, FakeSeparator())
    extract(client)
    assert separator.started.wait(WAIT_SEC)
    separator.release.set()

    assert wait_ended(client)["state"] == DONE
    assert fetcher.calls == []
