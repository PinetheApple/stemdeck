"""The vocal split and the lyrics edits while the stems folder moves: each is
refused with the move's own message, writes nothing into the folder, and
works again once the move is over (abandoned here; a restart in real life)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from unittest.mock import patch

import pytest

import app.api.jobs as jobs_mod
import app.pipeline.lyrics_lookup as ll
from app.core import stems_location
from app.core.models import VOCAL_SPLIT_CHOICE_SPLIT, Job
from app.pipeline import vocal_split as vs_mod
from tests.test_lyrics_align import LINES, lrc
from tests.test_lyrics_api import ROWS, TAGS, Lrclib, _done_job, _synced_job
from tests.test_lyrics_api import _isolate_registry as _isolate_registry  # noqa: F401
from tests.test_lyrics_api import client as client  # noqa: F401
from tests.test_lyrics_choice_api import PICK
from tests.test_vocal_split_api import JOB_ID as SPLIT_JOB_ID
from tests.test_vocal_split_api import wait_for, worked


def _split_job() -> Job:
    job = _done_job(job_id=SPLIT_JOB_ID)
    (jobs_mod.JOBS_DIR / job.id / "stems" / "vocals.wav").write_bytes(b"RIFF")
    return job


def _tagged_job() -> Job:
    return _done_job(audio_tags=TAGS)


def _aligned_job() -> Job:
    return _synced_job([t + 2 for t in LINES])


SPLIT = (jobs_mod.STEMS_FOLDER_MOVING_SPLIT, _split_job)
LYRICS = (jobs_mod.STEMS_FOLDER_MOVING, _synced_job)

# (method, route under the job, JSON body, refusal detail, job maker, status once the move is over)
GUARDED: list[tuple[str, str, dict | None, str, Callable[[], Job], int]] = [
    ("POST", "vocal-split", None, *SPLIT, 202),
    ("PUT", "vocal-split/choice", {"choice": VOCAL_SPLIT_CHOICE_SPLIT}, *SPLIT, 200),
    ("POST", "lyrics/lookup", {}, jobs_mod.STEMS_FOLDER_MOVING, _tagged_job, 200),
    ("POST", "lyrics/offset", {"offset_sec": 1}, *LYRICS, 200),
    ("POST", "lyrics/align", {}, jobs_mod.STEMS_FOLDER_MOVING, _aligned_job, 200),
    ("PUT", "lyrics/user-text", {"text": "My own words"}, *LYRICS, 200),
    ("DELETE", "lyrics/user-text", None, *LYRICS, 200),
    ("PUT", "lyrics/user-synced", {"synced": lrc([t + 1 for t in LINES])}, *LYRICS, 200),
    ("DELETE", "lyrics/user-synced", None, *LYRICS, 200),
    ("PUT", "lyrics", PICK, *LYRICS, 200),
    # Answers as GET .../lyrics then would: removed.
    ("DELETE", "lyrics", None, *LYRICS, 404),
]


def _folder() -> dict[str, bytes]:
    root: Path = jobs_mod.JOBS_DIR
    return {str(p.relative_to(root)): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def _call(client, method: str, job: Job, route: str, body: dict | None):
    kwargs = {} if body is None else {"json": body}
    return client.request(method, f"/api/jobs/{job.id}/{route}", **kwargs)


@pytest.fixture(autouse=True)
def _offline_services(monkeypatch):
    monkeypatch.setattr(vs_mod, "split_vocals", worked)
    with patch.object(ll, "_fetch_json", Lrclib(ROWS)):
        yield


@pytest.mark.parametrize(
    "method, route, body, detail, make_job, ok",
    GUARDED,
    ids=[f"{m} {r}" for m, r, *_ in GUARDED],
)
def test_refused_while_the_stems_folder_moves(
    client, monkeypatch, method, route, body, detail, make_job, ok
):
    job = make_job()
    before = _folder()
    monkeypatch.setattr(stems_location, "_relocating", True)

    r = _call(client, method, job, route, body)

    assert r.status_code == 409
    assert r.json()["detail"] == detail
    assert _folder() == before, "nothing may be written into a folder being moved"

    stems_location.abandon_relocation()
    assert _call(client, method, job, route, body).status_code == ok
    if route == "vocal-split":
        wait_for(client)


def test_a_track_that_has_lyrics_still_shows_them_while_the_folder_moves(client, monkeypatch):
    job = _synced_job()
    monkeypatch.setattr(stems_location, "_relocating", True)
    r = client.post(f"/api/jobs/{job.id}/lyrics/lookup", json={})
    assert r.status_code == 200
    assert r.json()["synced"] == lrc(LINES)
