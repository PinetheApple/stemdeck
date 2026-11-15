"""Trash, restore, delete, cancel, audio tags, queue order and setlists while
the stems folder moves: 409, nothing written, and working again once the move
is over. Opening a song meanwhile still answers, without keeping anything."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest

import app.api.jobs as jobs_mod
from app.core import stems_location
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import jobqueue
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_lyrics_api import _done_job
from tests.test_lyrics_api import _isolate_registry as _isolate_registry  # noqa: F401
from tests.test_lyrics_api import client as client  # noqa: F401
from tests.test_stems_api import _tiny_wav
from tests.test_stems_move_guard_api import _folder
from tests.test_vocal_envelope_api import _sung_then_silent

TRASHED_AT = 1_700_000_000.0
FIRST_QUEUED = "bbbbbbbbbbbb"
SECOND_QUEUED = "cccccccccccc"


def _trashed_job() -> Job:
    return _done_job(trashed_at=TRASHED_AT)


# (method, route under the job, job maker)
GUARDED: list[tuple[str, str | None, Callable[[], Job]]] = [
    ("POST", "trash", _done_job),
    ("POST", "restore", _trashed_job),
    ("DELETE", None, _trashed_job),
    ("POST", "cancel", _done_job),
    ("POST", "audio-tags", _done_job),
]


def _moving(monkeypatch) -> dict[str, bytes]:
    before = _folder()
    monkeypatch.setattr(stems_location, "_relocating", True)
    return before


def _assert_refused(r, before: dict[str, bytes]) -> None:
    assert r.status_code == 409
    assert r.json()["detail"] == jobs_mod.STEMS_FOLDER_MOVING_EDIT
    assert _folder() == before, "nothing may be written into a folder being moved"


@pytest.mark.parametrize(
    "method, route, make_job",
    GUARDED,
    ids=[f"{m} {r or 'job'}" for m, r, _ in GUARDED],
)
def test_song_actions_refused_while_the_folder_moves(client, monkeypatch, method, route, make_job):
    job = make_job()
    url = f"/api/jobs/{job.id}" + (f"/{route}" if route else "")
    before = _moving(monkeypatch)

    _assert_refused(client.request(method, url), before)

    stems_location.abandon_relocation()
    assert client.request(method, url).status_code == 200


def _queue_two() -> None:
    for job_id in (FIRST_QUEUED, SECOND_QUEUED):
        _jobs[job_id] = Job(id=job_id, source_url=f"https://example.com/{job_id}")
        jobqueue._queue.append(job_id)


def test_queue_reorder_refused_while_the_folder_moves(client, monkeypatch):
    _queue_two()
    move_first = {"job_id": SECOND_QUEUED, "after": None}
    before = _moving(monkeypatch)

    _assert_refused(client.post("/api/queue/reorder", json=move_first), before)
    assert jobqueue.snapshot()[1] == [FIRST_QUEUED, SECOND_QUEUED]

    stems_location.abandon_relocation()
    assert client.post("/api/queue/reorder", json=move_first).status_code == 200
    assert jobqueue.snapshot()[1] == [SECOND_QUEUED, FIRST_QUEUED]


def test_setlist_changes_refused_while_the_folder_moves(client, monkeypatch):
    song = _done_job()
    made = client.post("/api/setlists", json={"name": "Gig", "song_ids": [song.id]}).json()
    url = f"/api/setlists/{made['id']}"
    before = _moving(monkeypatch)

    _assert_refused(client.post("/api/setlists", json={"name": "Another"}), before)
    _assert_refused(client.patch(url, json={"name": "Renamed"}), before)
    _assert_refused(client.delete(url), before)

    stems_location.abandon_relocation()
    assert client.post("/api/setlists", json={"name": "Another"}).status_code == 201
    assert client.patch(url, json={"name": "Renamed"}).status_code == 200
    assert client.delete(url).status_code == 200


def _stems(job: Job) -> Path:
    return jobs_mod.JOBS_DIR / job.id / "stems"


def test_vocal_envelope_answers_without_keeping_it_while_the_folder_moves(client, monkeypatch):
    job = _done_job()
    _sung_then_silent(_stems(job) / "vocals.wav")
    before = _moving(monkeypatch)

    r = client.get(f"/api/jobs/{job.id}/vocal-envelope")

    assert r.status_code == 200
    assert r.json()["db"], "the envelope is still computed and served"
    assert _folder() == before

    stems_location.abandon_relocation()
    kept = client.get(f"/api/jobs/{job.id}/vocal-envelope")
    assert kept.json() == r.json()
    assert json.loads((_stems(job) / "vocal_envelope.json").read_text(encoding="utf-8")) == r.json()


def test_stem_mp3_answers_without_keeping_it_while_the_folder_moves(client, monkeypatch):
    skip_without_ffmpeg()
    job = _done_job()
    (_stems(job) / "vocals.wav").write_bytes(_tiny_wav())
    before = _moving(monkeypatch)

    r = client.get(f"/api/jobs/{job.id}/stems/vocals.mp3")

    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content
    assert _folder() == before

    stems_location.abandon_relocation()
    assert client.get(f"/api/jobs/{job.id}/stems/vocals.mp3").status_code == 200
    assert (_stems(job) / "vocals.mp3").is_file()
