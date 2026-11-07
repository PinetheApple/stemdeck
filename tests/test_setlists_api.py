"""Setlists: named, ordered lists of library songs kept on the server."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.core import setlists as store
from app.core.config import SETLIST_MAX_SONGS, SETLIST_NAME_MAX_CHARS
from app.core.models import Job
from app.core.registry import _jobs, register
from app.main import app

SONG_A = "aaaaaaaaaaaa"
SONG_B = "bbbbbbbbbbbb"
SONG_C = "cccccccccccc"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    for song_id in (SONG_A, SONG_B, SONG_C):
        register(Job(id=song_id, status="done", title=f"Song {song_id[0]}"))
    yield
    _jobs.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def _create(client: TestClient, name: str = "Friday gig", song_ids=(SONG_A, SONG_B)) -> dict:
    resp = client.post("/api/setlists", json={"name": name, "song_ids": list(song_ids)})
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_create_list_update_delete(client: TestClient) -> None:
    created = _create(client, name="  Friday gig  ")
    assert set(created) == {"id", "name", "song_ids", "updated_at"}
    assert created["name"] == "Friday gig"
    assert created["song_ids"] == [SONG_A, SONG_B]

    assert client.get("/api/setlists").json() == [created]

    resp = client.patch(f"/api/setlists/{created['id']}", json={"song_ids": [SONG_C, SONG_A]})
    assert resp.status_code == 200
    assert resp.json()["song_ids"] == [SONG_C, SONG_A]
    assert resp.json()["name"] == "Friday gig"
    assert resp.json()["updated_at"] >= created["updated_at"]

    resp = client.patch(f"/api/setlists/{created['id']}", json={"name": "Saturday"})
    assert resp.json()["name"] == "Saturday"
    assert resp.json()["song_ids"] == [SONG_C, SONG_A]

    resp = client.delete(f"/api/setlists/{created['id']}")
    assert resp.status_code == 200
    assert resp.json() == {"id": created["id"], "status": "deleted"}
    assert client.get("/api/setlists").json() == []


def test_an_empty_setlist_is_allowed(client: TestClient) -> None:
    resp = client.post("/api/setlists", json={"name": "Later"})
    assert resp.status_code == 201
    assert resp.json()["song_ids"] == []


@pytest.mark.parametrize(
    "body",
    [
        {"song_ids": [SONG_A]},
        {"name": "", "song_ids": []},
        {"name": "   ", "song_ids": []},
        {"name": "x" * (SETLIST_NAME_MAX_CHARS + 1), "song_ids": []},
        {"name": "Gig", "song_ids": [SONG_A, SONG_A]},
        {"name": "Gig", "song_ids": ["../../etc"]},
        {"name": "Gig", "song_ids": ["dddddddddddd"]},
        {"name": "Gig", "song_ids": [SONG_A] * (SETLIST_MAX_SONGS + 1)},
        {"name": "Gig", "songs": [SONG_A]},
        {"name": None},
    ],
)
def test_create_refuses_bad_bodies(client: TestClient, body: dict) -> None:
    assert client.post("/api/setlists", json=body).status_code == 422
    assert client.get("/api/setlists").json() == []


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"name": ""},
        {"name": None},
        {"song_ids": None},
        {"song_ids": [SONG_B, SONG_B]},
        {"song_ids": ["dddddddddddd"]},
        {"title": "Gig"},
    ],
)
def test_update_refuses_bad_bodies(client: TestClient, body: dict) -> None:
    created = _create(client)
    assert client.patch(f"/api/setlists/{created['id']}", json=body).status_code == 422
    assert client.get("/api/setlists").json() == [created]


@pytest.mark.parametrize("setlist_id", ["0123456789ab", "not-a-setlist", "ABCDEF012345"])
def test_unknown_setlist_is_404(client: TestClient, setlist_id: str) -> None:
    _create(client)
    assert client.patch(f"/api/setlists/{setlist_id}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/setlists/{setlist_id}").status_code == 404


def test_setlists_survive_a_restart() -> None:
    with TestClient(app) as first:
        created = _create(first)
    on_disk = json.loads(store.setlists_path(cfg.JOBS_DIR).read_text(encoding="utf-8"))
    assert on_disk["setlists"] == [created]
    with TestClient(app) as second:
        assert second.get("/api/setlists").json() == [created]


def test_deleting_a_song_removes_it_from_every_setlist(client: TestClient) -> None:
    first = _create(client, name="One", song_ids=(SONG_A, SONG_B))
    second = _create(client, name="Two", song_ids=(SONG_B, SONG_C))
    untouched = _create(client, name="Three", song_ids=(SONG_C,))

    assert client.delete(f"/api/jobs/{SONG_B}").status_code == 200

    on_disk = {s["id"]: s for s in store.list_all(cfg.JOBS_DIR)}
    assert on_disk[first["id"]]["song_ids"] == [SONG_A]
    assert on_disk[second["id"]]["song_ids"] == [SONG_C]
    assert on_disk[untouched["id"]] == untouched


def test_a_song_dropped_some_other_way_is_not_served(client: TestClient) -> None:
    _create(client)
    _jobs.pop(SONG_A)
    assert client.get("/api/setlists").json()[0]["song_ids"] == [SONG_B]


def test_a_damaged_file_reads_as_no_setlists(client: TestClient) -> None:
    store.setlists_path(cfg.JOBS_DIR).write_text("[not json", encoding="utf-8")
    assert client.get("/api/setlists").json() == []
    _create(client)
    assert len(client.get("/api/setlists").json()) == 1
