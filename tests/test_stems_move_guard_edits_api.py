"""Section, beat grid, favourite and rename edits while the stems folder moves
(#177): 409, nothing written, and working again once the move is over."""

from __future__ import annotations

import json

import pytest

import app.api.jobs as jobs_mod
from app.core import stems_location
from app.core.models import Job
from tests.test_lyrics_api import _done_job
from tests.test_lyrics_api import _isolate_registry as _isolate_registry  # noqa: F401
from tests.test_lyrics_api import client as client  # noqa: F401
from tests.test_stems_move_guard_api import _folder

DETECTED_GRID = {"version": 1, "bpm": 120.0, "duration": 10.0, "beats": [0.0, 0.5, 1.0]}
EDITED_BEATS = {"beats": [0.0, 0.5, 1.0, 1.5], "bars": []}
TEMPO = {"tempo": {"bpm": 100.0}}
SECTIONS = {
    "sections": [{"id": "s1", "name": "Intro", "start": 0.0, "end": 4.0, "color": "#ff7f50"}]
}

BAND = {"id": "Q42", "name": "The Band"}
RENAME = None

# (method, route under the job or RENAME for the job itself, JSON body)
GUARDED: list[tuple[str, str | None, dict | None]] = [
    ("PATCH", "sections", SECTIONS),
    ("PATCH", "beats", EDITED_BEATS),
    ("PATCH", "beats", TEMPO),
    ("DELETE", "beats", None),
    ("PUT", "favorite", {"favorite": True}),
    ("PATCH", RENAME, {"title": "Renamed"}),
    ("PATCH", RENAME, {"band": BAND}),
]


def _edited_job() -> Job:
    job = _done_job()
    stems = jobs_mod.JOBS_DIR / job.id / "stems"
    (stems / "beats.json").write_text(json.dumps(DETECTED_GRID), encoding="utf-8")
    (stems / "beats.user.json").write_text(
        json.dumps({"version": 1, **EDITED_BEATS}), encoding="utf-8"
    )
    (jobs_mod.JOBS_DIR / job.id / "metadata.json").write_text("{}", encoding="utf-8")
    return job


def _call(client, method: str, job: Job, route: str | None, body: dict | None):
    url = f"/api/jobs/{job.id}" + (f"/{route}" if route else "")
    return client.request(method, url, **({} if body is None else {"json": body}))


@pytest.mark.parametrize(
    "method, route, body",
    GUARDED,
    ids=[f"{m} {r or 'rename'} {next(iter(b or {}), '')}" for m, r, b in GUARDED],
)
def test_refused_while_the_stems_folder_moves(client, monkeypatch, method, route, body):
    job = _edited_job()
    before = _folder()
    monkeypatch.setattr(stems_location, "_relocating", True)

    r = _call(client, method, job, route, body)

    assert r.status_code == 409
    assert r.json()["detail"] == jobs_mod.STEMS_FOLDER_MOVING_EDIT
    assert _folder() == before, "nothing may be written into a folder being moved"

    stems_location.abandon_relocation()
    assert _call(client, method, job, route, body).status_code == 200
