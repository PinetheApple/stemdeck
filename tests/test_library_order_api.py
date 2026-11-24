"""My order: the user's drag order of library songs, kept on the server so the
desktop and the phone share it."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import library as library_api
from app.api.jobs import STEMS_FOLDER_MOVING_EDIT
from app.core import library_order as store
from app.core import stems_location
from app.core.config import LIBRARY_ORDER_MAX_SONGS
from app.core.models import Job
from app.core.registry import _jobs, register
from app.main import app

SONG_A = "aaaaaaaaaaaa"
SONG_B = "bbbbbbbbbbbb"
SONG_C = "cccccccccccc"
UNKNOWN = "dddddddddddd"
URL = "/api/library/order"


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


def _put(client: TestClient, song_ids: list) -> dict:
    resp = client.put(URL, json={"song_ids": song_ids})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_no_order_yet_is_empty(client: TestClient) -> None:
    resp = client.get(URL)
    assert resp.status_code == 200
    assert resp.json() == {"song_ids": []}


def test_put_replaces_the_order_on_disk(client: TestClient) -> None:
    assert _put(client, [SONG_C, SONG_A]) == {"song_ids": [SONG_C, SONG_A]}
    assert _put(client, [SONG_B, SONG_C, SONG_A]) == {"song_ids": [SONG_B, SONG_C, SONG_A]}
    on_disk = json.loads(store.library_order_path(cfg.JOBS_DIR).read_text(encoding="utf-8"))
    assert on_disk == {"version": 1, "song_ids": [SONG_B, SONG_C, SONG_A]}
    assert client.get(URL).json() == {"song_ids": [SONG_B, SONG_C, SONG_A]}


def test_duplicates_are_dropped_keeping_the_first(client: TestClient) -> None:
    assert _put(client, [SONG_B, SONG_A, SONG_B, SONG_A]) == {"song_ids": [SONG_B, SONG_A]}


@pytest.mark.parametrize("bad_id", ["../../etc", "ABCDEF012345", "aaaa"])
def test_a_malformed_id_fails_body_validation(client: TestClient, bad_id: str) -> None:
    resp = client.put(URL, json={"song_ids": [SONG_A, bad_id]})
    assert resp.status_code == 422
    [error] = resp.json()["detail"]
    assert error["loc"] == ["body", "song_ids"]
    assert "song ids must be job ids" in error["msg"]


def test_an_unknown_id_is_refused_by_name(client: TestClient) -> None:
    resp = client.put(URL, json={"song_ids": [SONG_A, UNKNOWN]})
    assert resp.status_code == 422
    assert resp.json()["detail"] == f"unknown song ids: {UNKNOWN}"


@pytest.mark.parametrize(
    "body",
    [
        {"song_ids": [SONG_A, UNKNOWN]},
        {"song_ids": ["../../etc"]},
        {"song_ids": [SONG_A] * (LIBRARY_ORDER_MAX_SONGS + 1)},
        {"song_ids": None},
        {"songs": [SONG_A]},
        {},
    ],
)
def test_bad_bodies_are_refused_and_change_nothing(client: TestClient, body: dict) -> None:
    _put(client, [SONG_A, SONG_B])
    assert client.put(URL, json=body).status_code == 422
    assert client.get(URL).json() == {"song_ids": [SONG_A, SONG_B]}


def test_a_song_dropped_some_other_way_is_not_served(client: TestClient) -> None:
    _put(client, [SONG_A, SONG_B, SONG_C])
    _jobs.pop(SONG_B)
    assert client.get(URL).json() == {"song_ids": [SONG_A, SONG_C]}


def test_a_hand_edited_file_is_served_without_repeats(client: TestClient) -> None:
    repeated = {"version": 1, "song_ids": [SONG_B, SONG_A, SONG_B, 7, SONG_A]}
    store.library_order_path(cfg.JOBS_DIR).write_text(json.dumps(repeated), encoding="utf-8")
    assert client.get(URL).json() == {"song_ids": [SONG_B, SONG_A]}


def test_a_trashed_song_keeps_its_place_through_restore(client: TestClient) -> None:
    _put(client, [SONG_A, SONG_B, SONG_C])
    assert client.post(f"/api/jobs/{SONG_B}/trash").status_code == 200
    assert client.get(URL).json() == {"song_ids": [SONG_A, SONG_B, SONG_C]}
    assert client.post(f"/api/jobs/{SONG_B}/restore").status_code == 200
    assert client.get(URL).json() == {"song_ids": [SONG_A, SONG_B, SONG_C]}


def test_a_damaged_file_reads_as_no_order(client: TestClient) -> None:
    store.library_order_path(cfg.JOBS_DIR).write_text("[not json", encoding="utf-8")
    assert client.get(URL).json() == {"song_ids": []}
    assert _put(client, [SONG_A]) == {"song_ids": [SONG_A]}


def test_deleting_a_song_takes_it_out_of_the_order(client: TestClient) -> None:
    _put(client, [SONG_A, SONG_B, SONG_C])
    assert client.delete(f"/api/jobs/{SONG_B}").status_code == 200
    assert store.read_order(cfg.JOBS_DIR) == [SONG_A, SONG_C]


def test_replace_song_keeps_the_old_copys_place() -> None:
    store.save_order(cfg.JOBS_DIR, [SONG_A, SONG_B, SONG_C])
    store.replace_song(cfg.JOBS_DIR, SONG_B, UNKNOWN)
    assert store.read_order(cfg.JOBS_DIR) == [SONG_A, UNKNOWN, SONG_C]


def test_replace_song_already_listed_drops_the_old_copy() -> None:
    store.save_order(cfg.JOBS_DIR, [SONG_A, SONG_B, SONG_C])
    store.replace_song(cfg.JOBS_DIR, SONG_A, SONG_C)
    assert store.read_order(cfg.JOBS_DIR) == [SONG_B, SONG_C]


def test_writes_are_refused_while_the_stems_folder_moves(client: TestClient, monkeypatch) -> None:
    _put(client, [SONG_A, SONG_B])
    before = store.library_order_path(cfg.JOBS_DIR).read_bytes()
    monkeypatch.setattr(stems_location, "_relocating", True)

    resp = client.put(URL, json={"song_ids": [SONG_B, SONG_A]})
    assert resp.status_code == 409
    assert resp.json()["detail"] == STEMS_FOLDER_MOVING_EDIT
    assert store.library_order_path(cfg.JOBS_DIR).read_bytes() == before
    assert client.get(URL).json() == {"song_ids": [SONG_A, SONG_B]}

    stems_location.abandon_relocation()
    assert _put(client, [SONG_B, SONG_A]) == {"song_ids": [SONG_B, SONG_A]}


def test_a_failed_write_is_a_500(client: TestClient, monkeypatch) -> None:
    def _fail(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(library_api.store, "save_order", _fail)
    resp = client.put(URL, json={"song_ids": [SONG_A]})
    assert resp.status_code == 500
    assert resp.json()["detail"] == "failed to save library order"
