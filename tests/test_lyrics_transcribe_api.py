"""POST/GET /api/jobs/{id}/lyrics/transcribe: lyrics transcribed on demand.

The worker is a stub script (tests/test_lyrics_retime.py's stub_worker), so
no model runs; the run itself goes through the real endpoint, background task
and pipeline lock."""

from __future__ import annotations

import json
import sys
import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.api.jobs as jobs_mod
from app.core import settings as settings_mod
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import lyrics_retime as rt
from app.pipeline import transcribe_on_demand as tod
from app.pipeline.lyrics_lookup import LYRICS_REMOVED_FILE
from tests.test_lyrics_retime import entry, sing, stub_worker
from tests.test_lyrics_retime_api import _release, hold_the_lock

JOB_ID = "abcdef123456"
URL = f"/api/jobs/{JOB_ID}/lyrics/transcribe"
LYRICS = f"/api/jobs/{JOB_ID}/lyrics"
CANCEL = f"/api/jobs/{JOB_ID}/cancel"
HEARD = sing("znowu to samo znowu biegnę", 20) + sing("chciałabym bardzo choć na chwilę", 26)
SLEEPER = [sys.executable, "-c", "import time; time.sleep(30)"]


@pytest.fixture(autouse=True)
def _isolate():
    _jobs.clear()
    rt.RETIME_RUNS.runs.clear()
    tod.TRANSCRIBE_RUNS.runs.clear()
    yield
    _jobs.clear()
    rt.RETIME_RUNS.runs.clear()
    tod.TRANSCRIBE_RUNS.runs.clear()


@pytest.fixture(autouse=True)
def pin_device(monkeypatch):
    def to(device: str) -> None:
        monkeypatch.setattr(tod, "get_demucs_device", lambda: device)

    to("cpu")
    return to


@pytest.fixture
def client():
    with patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None):
        from app.main import app

        with TestClient(app) as c:
            yield c


def done_job(lyrics: dict | None = None, vocals: bool = True, **fields) -> Job:
    job = Job(id=JOB_ID, status="done", title="W biegu", duration_sec=40.0, **fields)
    job.compute_device = "cpu"
    _jobs[job.id] = job
    stems = jobs_mod.JOBS_DIR / job.id / "stems"
    stems.mkdir(parents=True)
    if vocals:
        (stems / "vocals.wav").write_bytes(b"RIFF")
    if lyrics is not None:
        lyrics_file().write_text(json.dumps(lyrics), encoding="utf-8")
    return job


def lyrics_file():
    return jobs_mod.JOBS_DIR / JOB_ID / "lyrics.json"


def wait_for(client, until=lambda body: body["state"] != "running") -> dict:
    deadline = time.monotonic() + 20
    while True:
        body = client.get(URL).json()
        if until(body) or time.monotonic() > deadline:
            return body
        time.sleep(0.05)


def worker_started():
    deadline = time.monotonic() + 10
    while tod.TRANSCRIBE_RUNS.current(JOB_ID).phase == "queued" and time.monotonic() < deadline:
        time.sleep(0.05)


def test_a_cpu_run_under_auto_transcribes_the_vocals(client, monkeypatch, tmp_path):
    job = done_job()
    calls: list[str] = []
    stub_worker(monkeypatch, tmp_path, HEARD, calls)
    before = client.get(URL).json()
    assert before == {"state": "idle", "available": True, "unavailable": None, "device": "cpu"}
    r = client.post(URL)
    assert r.status_code == 202
    assert r.json()["state"] == "running" and r.json()["available"] is False
    assert wait_for(client)["state"] == "done"
    lyrics = client.get(LYRICS).json()
    assert lyrics["source"] == "whisper" and lyrics["language"] == "pl"
    assert lyrics["synced"].startswith("[00:20.00]<00:20.00>znowu")
    assert calls == ["cpu"] and job.has_lyrics
    assert not rt.transcript_path(jobs_mod.JOBS_DIR / JOB_ID).exists()
    after = client.get(URL).json()
    assert after["available"] is False and after["unavailable"] == "has_lyrics"


def test_a_kept_transcript_is_not_used(client, monkeypatch, tmp_path):
    done_job()
    calls: list[str] = []
    stub_worker(monkeypatch, tmp_path, HEARD, calls)
    rt.save_transcript(jobs_mod.JOBS_DIR / JOB_ID, words=sing("other words here", 5), language="pl")
    client.post(URL)
    assert wait_for(client)["state"] == "done"
    assert calls == ["cpu"]
    assert client.get(LYRICS).json()["plain"].startswith("znowu")


def test_off_is_not_offered_and_refused(client):
    done_job()
    settings_mod.set_transcribe_lyrics("off")
    body = client.get(URL).json()
    assert body["available"] is False and body["unavailable"] == "off"
    r = client.post(URL)
    assert r.status_code == 409 and r.json()["detail"] == "transcription is off"


@pytest.mark.parametrize(
    ("lyrics", "reason", "detail"),
    [
        (entry(source="user"), "user_lyrics", "user lyrics kept"),
        (entry(), "has_lyrics", "lyrics already exist"),
    ],
)
def test_existing_lyrics_are_never_replaced(client, lyrics, reason, detail):
    done_job(lyrics)
    before = lyrics_file().read_bytes()
    assert client.get(URL).json()["unavailable"] == reason
    r = client.post(URL)
    assert r.status_code == 409 and r.json()["detail"] == detail
    assert lyrics_file().read_bytes() == before


def test_a_job_not_done_or_without_vocals_is_refused(client):
    job = done_job(vocals=False)
    r = client.post(URL)
    assert r.status_code == 409 and r.json()["detail"] == "no vocals stem"
    job.status = "running"
    r = client.post(URL)
    assert r.status_code == 409 and r.json()["detail"] == "job not ready"
    assert client.get(URL).json()["unavailable"] == "not_ready"


def test_unknown_job_is_404(client):
    assert client.get(URL).status_code == 404
    assert client.post(URL).status_code == 404


def test_one_run_at_a_time_while_queued(client, monkeypatch, tmp_path):
    done_job()
    stub_worker(monkeypatch, tmp_path, HEARD)
    lock = hold_the_lock(client, monkeypatch)
    assert client.post(URL).status_code == 202
    body = client.get(URL).json()
    assert body["state"] == "running" and body["phase"] == "queued" and body["progress"] == 0
    r = client.post(URL)
    assert r.status_code == 409 and r.json()["detail"] == "transcription already running"
    client.portal.call(_release, lock)
    assert wait_for(client)["state"] == "done"


def test_refused_while_the_lyrics_are_being_timed(client):
    done_job()
    rt.RETIME_RUNS.claim(JOB_ID)
    r = client.post(URL)
    assert r.status_code == 409 and r.json()["detail"] == "lyrics timing already running"


def test_timing_is_refused_while_a_transcription_runs(client, monkeypatch):
    done_job(entry())
    tod.TRANSCRIBE_RUNS.claim(JOB_ID)
    r = client.post(f"{LYRICS}/retime")
    assert r.status_code == 409 and r.json()["detail"] == "transcription already running"
    assert rt.RETIME_RUNS.current(JOB_ID) is None


def test_cancel_reaches_both_kinds_of_run(client):
    done_job()
    retime = rt.RETIME_RUNS.claim(JOB_ID)
    transcription = tod.TRANSCRIBE_RUNS.claim(JOB_ID)
    assert client.post(CANCEL).status_code == 200
    assert retime.cancel.is_set() and retime.state == "idle"
    assert transcription.cancel.is_set() and transcription.state == "cancelled"


def test_cancel_during_a_split_reaches_a_queued_transcription(client):
    from app.pipeline.vocal_split import VOCAL_SPLIT_RUNS

    done_job()
    split = VOCAL_SPLIT_RUNS.claim(JOB_ID)
    split.started = True
    transcription = tod.TRANSCRIBE_RUNS.claim(JOB_ID)
    try:
        assert client.post(CANCEL).status_code == 200
    finally:
        VOCAL_SPLIT_RUNS.forget(JOB_ID)
    assert split.cancel.is_set()
    assert transcription.state == "cancelled"


def test_a_queued_run_is_cancelled_at_once(client, monkeypatch, tmp_path):
    done_job()
    calls: list[str] = []
    stub_worker(monkeypatch, tmp_path, HEARD, calls)
    lock = hold_the_lock(client, monkeypatch)
    client.post(URL)
    assert client.post(CANCEL).status_code == 200
    assert client.get(URL).json()["state"] == "cancelled"
    client.portal.call(_release, lock)
    time.sleep(0.3)
    assert client.get(URL).json()["state"] == "cancelled"
    assert calls == [] and not lyrics_file().exists()


def test_a_running_worker_is_cancelled(client, monkeypatch):
    done_job()
    monkeypatch.setattr("app.pipeline.transcribe._spawn_worker_cmd", lambda v, d: SLEEPER)
    client.post(URL)
    worker_started()
    started = time.monotonic()
    client.post(CANCEL)
    body = wait_for(client)
    assert body["state"] == "cancelled" and body["available"] is True
    assert time.monotonic() - started < 10
    assert not lyrics_file().exists()
    assert client.get(f"/api/jobs/{JOB_ID}").json()["status"] == "done"


def test_quiet_vocals_are_too_little_singing(client, monkeypatch, tmp_path):
    done_job(stem_presence={"vocals": 1})
    calls: list[str] = []
    stub_worker(monkeypatch, tmp_path, HEARD, calls)
    client.post(URL)
    assert wait_for(client)["state"] == "no_singing"
    assert calls == [] and not lyrics_file().exists()


def test_too_few_words_heard_is_too_little_singing(client, monkeypatch, tmp_path):
    done_job()
    stub_worker(monkeypatch, tmp_path, sing("hej", 20))
    client.post(URL)
    body = wait_for(client)
    assert body["state"] == "no_singing" and body["available"] is True
    assert not lyrics_file().exists()


def test_a_failed_worker_is_failed(client):
    done_job()
    client.post(URL)
    assert wait_for(client)["state"] == "failed"
    assert not lyrics_file().exists()


def test_lyrics_pasted_meanwhile_win(client, monkeypatch, tmp_path):
    done_job()
    stub_worker(monkeypatch, tmp_path, HEARD)
    lock = hold_the_lock(client, monkeypatch)
    client.post(URL)
    r = client.put(f"{LYRICS}/user-text", json={"text": "my own words\nsecond line"})
    assert r.status_code == 200
    client.portal.call(_release, lock)
    assert wait_for(client)["state"] == "has_lyrics"
    assert client.get(LYRICS).json()["plain"] == "my own words\nsecond line"


def test_deleting_the_job_stops_its_run(client, monkeypatch):
    done_job()
    monkeypatch.setattr("app.pipeline.transcribe._spawn_worker_cmd", lambda v, d: SLEEPER)
    client.post(URL)
    worker_started()
    run = tod.TRANSCRIBE_RUNS.current(JOB_ID)
    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 200
    assert run.ended.is_set() and tod.TRANSCRIBE_RUNS.current(JOB_ID) is None


def reported_and_run(client, monkeypatch, tmp_path) -> tuple[str, list[str]]:
    calls: list[str] = []
    stub_worker(monkeypatch, tmp_path, HEARD, calls)
    reported = client.get(URL).json()["device"]
    client.post(URL)
    assert wait_for(client)["state"] == "done"
    return reported, calls


def test_a_cpu_fallback_job_runs_on_the_gpu_it_has_now(client, monkeypatch, tmp_path, pin_device):
    done_job().compute_device = "cpu (fallback from cuda)"
    pin_device("cuda")
    assert reported_and_run(client, monkeypatch, tmp_path) == ("cuda", ["cuda"])


@pytest.mark.parametrize(
    ("separated_on", "resolved"),
    [("cuda", "cpu"), ("mps", "mps")],
)
def test_a_machine_without_cuda_transcribes_on_the_cpu(
    client,
    monkeypatch,
    tmp_path,
    pin_device,
    separated_on,
    resolved,
):
    done_job().compute_device = separated_on
    pin_device(resolved)
    assert reported_and_run(client, monkeypatch, tmp_path) == ("cpu", ["cpu"])


def test_a_cpu_setting_on_a_cuda_machine_transcribes_on_the_cpu(client, monkeypatch, tmp_path):
    done_job().compute_device = "cuda"
    monkeypatch.setattr(tod, "get_demucs_device", settings_mod.get_demucs_device)
    monkeypatch.setattr(settings_mod, "detect_torch_device", lambda: "cuda")
    settings_mod.set_demucs_device("cpu")
    assert reported_and_run(client, monkeypatch, tmp_path) == ("cpu", ["cpu"])


def test_removed_lyrics_are_offered_a_transcription_which_ends_the_removal(
    client,
    monkeypatch,
    tmp_path,
):
    done_job(entry())
    removed = jobs_mod.JOBS_DIR / JOB_ID / LYRICS_REMOVED_FILE
    client.delete(LYRICS)
    assert removed.is_file()
    assert client.get(URL).json()["available"] is True
    stub_worker(monkeypatch, tmp_path, HEARD, [])
    assert client.post(URL).status_code == 202
    assert wait_for(client)["state"] == "done"
    assert client.get(LYRICS).json()["source"] == "whisper"
    assert not removed.exists()
