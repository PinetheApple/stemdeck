"""The lead/backing vocal split through the API (#275, #43): the stored
choice, the on-demand run with progress, cancel and retry, and what survives
a restart.

split_vocals is stubbed, so no model runs; the run itself goes through the
real endpoints, background task and pipeline lock."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.api.jobs as jobs_mod
from app.core import registry as registry_mod
from app.core.models import (
    VOCAL_SPLIT_CANCELLED,
    VOCAL_SPLIT_CHOICE_COMBINED,
    VOCAL_SPLIT_CHOICE_SPLIT,
    VOCAL_SPLIT_DONE,
    VOCAL_SPLIT_ERROR,
    VOCAL_SPLIT_FAILED_DISK_FULL,
    VOCAL_SPLIT_FAILED_OUT_OF_MEMORY,
    VOCAL_SPLIT_NONE,
    VOCAL_SPLIT_RUNNING,
    Job,
    JobCancelled,
)
from app.core.registry import _jobs
from app.pipeline import vocal_split as vs_mod
from tests.test_jobs_replaces import _finish, _new_job
from tests.test_lyrics_retime_api import _release, hold_the_lock

JOB_ID = "abcdefabc275"
SPLIT = f"/api/jobs/{JOB_ID}/vocal-split"
CHOICE = f"{SPLIT}/choice"
CANCEL = f"/api/jobs/{JOB_ID}/cancel"
EXTRA = ("lead_vocals", "backing_vocals")


@pytest.fixture(autouse=True)
def _isolate():
    _jobs.clear()
    vs_mod.VOCAL_SPLIT_RUNS.runs.clear()
    yield
    _jobs.clear()
    vs_mod.VOCAL_SPLIT_RUNS.runs.clear()


@pytest.fixture
def client():
    with patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None):
        from app.main import app

        with TestClient(app) as c:
            yield c


def stems_dir() -> Path:
    return jobs_mod.JOBS_DIR / JOB_ID / "stems"


def done_job(vocals: bool = True, **fields) -> Job:
    job = Job(id=JOB_ID, status="done", title="Test track", **fields)
    _jobs[job.id] = job
    stems_dir().mkdir(parents=True)
    if vocals:
        (stems_dir() / "vocals.wav").write_bytes(b"RIFF")
    return job


def worked(job, stems, *, cancelled, report):
    report(50)
    for name in EXTRA:
        (stems / f"{name}.wav").write_bytes(b"RIFF")
    return list(EXTRA)


def failed(job, stems, *, cancelled, report):
    raise vs_mod.VocalSplitFailed(
        "vocal split failed: no space left on device",
        code=VOCAL_SPLIT_FAILED_DISK_FULL,
        tail=["writing /home/someone/stems/lead_vocals.wav", "no space left on device"],
    )


class Blocking:
    """A split that reports half way, then waits for a cancel or a release."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.started = threading.Event()

    def __call__(self, job, stems, *, cancelled, report):
        report(50)
        self.started.set()
        while not self.release.wait(0.02):
            if cancelled():
                raise JobCancelled()
        return worked(job, stems, cancelled=cancelled, report=report)


def wait_for(client, until=lambda body: body["state"] != VOCAL_SPLIT_RUNNING) -> dict:
    deadline = time.monotonic() + 20
    while True:
        body = client.get(SPLIT).json()
        if until(body) or time.monotonic() > deadline:
            return body
        time.sleep(0.02)


def persisted_record() -> dict:
    data = json.loads(registry_mod.registry_path(jobs_mod.JOBS_DIR).read_text(encoding="utf-8"))
    return next(r for r in data["jobs"] if r["id"] == JOB_ID)


# --- the stored choice -----------------------------------------------------------


def test_the_choice_is_stored_with_the_song_before_it_is_done(client):
    job = Job(id=JOB_ID, status="queued", title="Waiting")
    _jobs[job.id] = job

    r = client.put(CHOICE, json={"choice": VOCAL_SPLIT_CHOICE_SPLIT})

    assert r.status_code == 200
    assert r.json()["vocal_split_choice"] == VOCAL_SPLIT_CHOICE_SPLIT
    assert persisted_record()["vocal_split_choice"] == VOCAL_SPLIT_CHOICE_SPLIT
    assert job.vocal_split == VOCAL_SPLIT_NONE, "storing a choice started a split"


def test_the_choice_can_go_back_to_combined(client):
    done_job(vocal_split_choice=VOCAL_SPLIT_CHOICE_SPLIT)

    r = client.put(CHOICE, json={"choice": VOCAL_SPLIT_CHOICE_COMBINED})

    assert r.json()["vocal_split_choice"] == VOCAL_SPLIT_CHOICE_COMBINED


def test_an_unknown_choice_is_refused(client):
    done_job()
    assert client.put(CHOICE, json={"choice": "karaoke"}).status_code == 422


def test_a_choice_for_an_unknown_song_is_404(client):
    assert client.put(CHOICE, json={"choice": VOCAL_SPLIT_CHOICE_SPLIT}).status_code == 404


def test_the_choice_survives_a_restart_before_any_split(tmp_path):
    """Not yet split, so nothing but the stored choice can say it was asked for."""
    job = Job(id=JOB_ID, status="done", title="Song")
    job.vocal_split_choice = VOCAL_SPLIT_CHOICE_SPLIT
    _jobs[job.id] = job

    registry_mod.persist(tmp_path)
    _jobs.clear()
    registry_mod.restore(tmp_path)

    assert _jobs[JOB_ID].vocal_split_choice == VOCAL_SPLIT_CHOICE_SPLIT
    assert _jobs[JOB_ID].vocal_split == VOCAL_SPLIT_NONE


def test_a_failure_survives_a_restart(tmp_path):
    job = Job(id=JOB_ID, status="done", title="Song", vocal_split=VOCAL_SPLIT_ERROR)
    job.vocal_split_choice = VOCAL_SPLIT_CHOICE_SPLIT
    job.vocal_split_error = VOCAL_SPLIT_FAILED_DISK_FULL
    _jobs[job.id] = job

    registry_mod.persist(tmp_path)
    _jobs.clear()
    registry_mod.restore(tmp_path)

    assert _jobs[JOB_ID].vocal_split == VOCAL_SPLIT_ERROR
    assert _jobs[JOB_ID].vocal_split_error == VOCAL_SPLIT_FAILED_DISK_FULL


def test_a_split_cut_short_by_a_restart_is_not_left_running(tmp_path):
    job = Job(id=JOB_ID, status="done", title="Song", vocal_split=VOCAL_SPLIT_RUNNING)
    job.vocal_split_choice = VOCAL_SPLIT_CHOICE_SPLIT
    _jobs[job.id] = job

    registry_mod.persist(tmp_path)
    _jobs.clear()
    registry_mod.restore(tmp_path)

    assert _jobs[JOB_ID].vocal_split == VOCAL_SPLIT_NONE
    assert _jobs[JOB_ID].vocal_split_choice == VOCAL_SPLIT_CHOICE_SPLIT


def test_a_song_split_before_the_choice_was_stored_comes_back_as_split():
    record = Job(id=JOB_ID, status="done", vocal_split=VOCAL_SPLIT_DONE).to_record()
    del record["vocal_split_choice"]

    assert Job.from_record(record).vocal_split_choice == VOCAL_SPLIT_CHOICE_SPLIT


def _orphan(tmp_path: Path, names: tuple[str, ...]) -> Path:
    stems = tmp_path / JOB_ID / "stems"
    stems.mkdir(parents=True)
    for name in names:
        (stems / f"{name}.wav").write_bytes(b"RIFF")
    return stems


def test_a_song_rebuilt_from_disk_keeps_its_split(tmp_path):
    _orphan(tmp_path, ("vocals", *EXTRA))
    registry_mod.restore(tmp_path)

    assert _jobs[JOB_ID].vocal_split == VOCAL_SPLIT_DONE
    assert _jobs[JOB_ID].vocal_split_choice == VOCAL_SPLIT_CHOICE_SPLIT


def test_a_song_rebuilt_from_disk_keeps_why_its_split_failed(tmp_path):
    stems = _orphan(tmp_path, ("vocals",))
    (stems / vs_mod.VOCAL_SPLIT_ERROR_FILE).write_text(
        "cause: out-of-memory\ncode: out_of_memory\n\n--- stderr tail ---\nCUDA out of memory\n",
        encoding="utf-8",
    )
    registry_mod.restore(tmp_path)

    assert _jobs[JOB_ID].vocal_split == VOCAL_SPLIT_ERROR
    assert _jobs[JOB_ID].vocal_split_error == VOCAL_SPLIT_FAILED_OUT_OF_MEMORY
    assert _jobs[JOB_ID].vocal_split_choice == VOCAL_SPLIT_CHOICE_SPLIT


def test_a_song_rebuilt_from_disk_without_a_split_is_combined(tmp_path):
    _orphan(tmp_path, ("vocals",))
    registry_mod.restore(tmp_path)

    assert _jobs[JOB_ID].vocal_split == VOCAL_SPLIT_NONE
    assert _jobs[JOB_ID].vocal_split_choice == VOCAL_SPLIT_CHOICE_COMBINED


# --- starting, following, retrying -----------------------------------------------


def test_a_finished_song_is_split_on_demand(client, monkeypatch):
    job = done_job()
    monkeypatch.setattr(vs_mod, "split_vocals", worked)

    r = client.post(SPLIT)

    assert r.status_code == 202
    assert wait_for(client)["state"] == VOCAL_SPLIT_DONE
    state = client.get(f"/api/jobs/{JOB_ID}").json()
    assert set(EXTRA) <= {s["name"] for s in state["stems"]}
    assert state["vocal_split_choice"] == VOCAL_SPLIT_CHOICE_SPLIT
    assert job.status == "done"
    assert persisted_record()["vocal_split"] == VOCAL_SPLIT_DONE


def test_a_running_split_shows_its_progress(client, monkeypatch):
    done_job()
    split = Blocking()
    monkeypatch.setattr(vs_mod, "split_vocals", split)

    client.post(SPLIT)
    assert split.started.wait(10)
    body = client.get(SPLIT).json()
    split.release.set()

    assert body["state"] == VOCAL_SPLIT_RUNNING
    assert body["phase"] == vs_mod.PHASE_SPLITTING
    assert body["progress"] == 0.5
    assert wait_for(client)["state"] == VOCAL_SPLIT_DONE


def test_a_failed_split_says_why_and_can_be_retried(client, monkeypatch):
    job = done_job()
    monkeypatch.setattr(vs_mod, "split_vocals", failed)

    client.post(SPLIT)
    body = wait_for(client)

    assert body["state"] == VOCAL_SPLIT_ERROR
    assert body["error"] == VOCAL_SPLIT_FAILED_DISK_FULL
    state = client.get(f"/api/jobs/{JOB_ID}").json()
    assert state["vocal_split_error"] == VOCAL_SPLIT_FAILED_DISK_FULL
    # The worker's words, and the paths in them, stay out of what the UI reads.
    assert "/home/" not in json.dumps(body) + json.dumps(state)
    assert (stems_dir() / vs_mod.VOCAL_SPLIT_ERROR_FILE).is_file()
    assert job.status == "done"

    monkeypatch.setattr(vs_mod, "split_vocals", worked)
    assert client.post(SPLIT).status_code == 202
    body = wait_for(client)
    assert body["state"] == VOCAL_SPLIT_DONE
    assert body["error"] is None
    assert not (stems_dir() / vs_mod.VOCAL_SPLIT_ERROR_FILE).exists()


def test_a_second_start_while_running_is_409(client, monkeypatch):
    done_job()
    split = Blocking()
    monkeypatch.setattr(vs_mod, "split_vocals", split)

    client.post(SPLIT)
    r = client.post(SPLIT)
    split.release.set()

    assert r.status_code == 409
    assert wait_for(client)["state"] == VOCAL_SPLIT_DONE


def test_a_done_split_is_not_run_again(client, monkeypatch):
    done_job(vocal_split=VOCAL_SPLIT_DONE)
    calls = []
    monkeypatch.setattr(vs_mod, "split_vocals", lambda *a, **k: calls.append(a))

    r = client.post(SPLIT)

    assert r.status_code == 202
    assert r.json()["state"] == VOCAL_SPLIT_DONE
    time.sleep(0.2)
    assert calls == []


def test_a_song_without_a_vocals_stem_is_refused(client):
    done_job(vocals=False)
    r = client.post(SPLIT)
    assert r.status_code == 409
    assert r.json()["detail"] == jobs_mod.NO_VOCALS_STEM


def test_a_song_not_yet_done_cannot_be_split(client):
    _jobs[JOB_ID] = Job(id=JOB_ID, status="separating", title="In progress")
    assert client.post(SPLIT).status_code == 404


def test_an_unknown_song_is_404(client):
    assert client.post(SPLIT).status_code == 404
    assert client.get(SPLIT).status_code == 404


# --- cancelling ---------------------------------------------------------------------


def test_a_running_split_can_be_cancelled(client, monkeypatch):
    job = done_job()
    split = Blocking()
    monkeypatch.setattr(vs_mod, "split_vocals", split)

    client.post(SPLIT)
    assert split.started.wait(10)
    client.post(CANCEL)
    body = wait_for(client)

    assert body["state"] == VOCAL_SPLIT_CANCELLED
    assert job.status == "done"
    assert not any((stems_dir() / f"{name}.wav").exists() for name in EXTRA)


def test_a_split_waiting_for_the_lock_is_cancelled_at_once(client, monkeypatch):
    done_job()
    calls = []
    monkeypatch.setattr(vs_mod, "split_vocals", lambda *a, **k: calls.append(a))
    lock = hold_the_lock(client, monkeypatch)

    client.post(SPLIT)
    assert client.get(SPLIT).json()["phase"] == vs_mod.PHASE_QUEUED
    client.post(CANCEL)
    assert client.get(SPLIT).json()["state"] == VOCAL_SPLIT_CANCELLED

    client.portal.call(_release, lock)
    time.sleep(0.3)
    assert calls == [], "a cancelled split ran once the lock was free"
    assert client.get(SPLIT).json()["state"] == VOCAL_SPLIT_CANCELLED


def test_deleting_the_song_stops_its_split(client, monkeypatch):
    done_job()
    split = Blocking()
    monkeypatch.setattr(vs_mod, "split_vocals", split)

    client.post(SPLIT)
    assert split.started.wait(10)
    r = client.delete(f"/api/jobs/{JOB_ID}")

    assert r.status_code == 200
    assert not (jobs_mod.JOBS_DIR / JOB_ID).exists()
    assert vs_mod.VOCAL_SPLIT_RUNS.current(JOB_ID) is None


def test_replacing_the_song_stops_its_split_before_its_files_go(client, monkeypatch):
    done_job()
    split = Blocking()
    monkeypatch.setattr(vs_mod, "split_vocals", split)
    client.post(SPLIT)
    assert split.started.wait(10)
    run = vs_mod.VOCAL_SPLIT_RUNS.current(JOB_ID)
    (stems_dir() / "vocals.wav").unlink()
    split_ended_at_removal = []
    remove = jobs_mod._rmtree_job

    def recording_remove(job_id):
        split_ended_at_removal.append(run.ended.is_set())
        return remove(job_id)

    monkeypatch.setattr(jobs_mod, "_rmtree_job", recording_remove)
    # The stub split holds the real pipeline lock until it is stopped.
    monkeypatch.setattr("app.pipeline.runner._pipeline_lock", asyncio.Semaphore(1))
    client.portal.call(_finish, _new_job(replaces=JOB_ID))

    assert JOB_ID not in _jobs
    assert split_ended_at_removal == [True]
    assert vs_mod.VOCAL_SPLIT_RUNS.current(JOB_ID) is None
