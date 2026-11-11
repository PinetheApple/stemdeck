"""The idle unload of the separation worker and the beat model (#90, from
upstream PR 1034).

The worker is a stub process behind the _spawn_worker_cmd seam, so "unloaded"
means the process is gone and "reloaded" means a new one served the next job.
The beat model is a fake behind _get_model. Only time is fake otherwise: each
resource reads a clock the test moves.
"""

from __future__ import annotations

import subprocess
import sys
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import settings
from app.core.models import Job, JobCancelled
from app.pipeline import beat_detect as bd
from app.pipeline import idle_unload
from app.pipeline import separate as sep_mod

_SUCCESS_WORKER = """
import sys, json, os
for line in sys.stdin:
    req = json.loads(line)
    d = os.path.join(req["job_dir"], "htdemucs_6s", "source")
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, "vocals.wav"), "wb").write(b"RIFF")
    sys.stderr.write("100%\\n@@DONE@@\\n")
    sys.stderr.flush()
"""

MIN = 60.0


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture()
def clock(monkeypatch) -> Clock:
    c = Clock()
    for res in (sep_mod.WORKER, bd.MODEL):
        monkeypatch.setattr(res, "_clock", c)
        monkeypatch.setattr(res, "_last_used", c.t)
    return c


@pytest.fixture(autouse=True)
def _reset():
    sep_mod._worker.clear()
    sep_mod._left_behind.clear()
    bd.reset_model_cache()
    yield
    sep_mod._kill_worker()
    sep_mod._left_behind.clear()
    bd.reset_model_cache()


@pytest.fixture()
def spawns(monkeypatch) -> list[str]:
    calls: list[str] = []

    def spawn(device: str) -> list[str]:
        calls.append(device)
        return [sys.executable, "-c", _SUCCESS_WORKER]

    monkeypatch.setattr(sep_mod, "_spawn_worker_cmd", spawn)
    monkeypatch.setattr(sep_mod, "get_demucs_device", lambda: "cpu")
    return calls


@pytest.fixture()
def minutes(monkeypatch):
    def use(value: int) -> None:
        monkeypatch.setattr(idle_unload, "get_idle_unload_minutes", lambda: value)

    return use


def _separate(tmp_path: Path, name: str) -> Job:
    job = Job(id=f"{name:0<12}"[:12])
    job_dir = tmp_path / name
    job_dir.mkdir()
    (job_dir / "source.wav").write_bytes(b"RIFF")
    stems = sep_mod.separate(job, job_dir / "source.wav", job_dir)
    assert (stems / "vocals.wav").is_file()
    return job


class _FakeBeats:
    def __call__(self, y, sr):
        return [0.5, 1.0, 1.5], [0.5]


@pytest.fixture()
def beat_loads(monkeypatch) -> list[int]:
    loads: list[int] = []

    def fake_get_model():
        if bd._model is None:
            loads.append(1)
            bd._model = _FakeBeats()
        return bd._model

    monkeypatch.setattr(bd, "_get_model", fake_get_model)
    return loads


# --- the timer ----------------------------------------------------------------


async def test_worker_unloads_after_the_idle_minutes_and_the_next_job_reloads_it(
    tmp_path, clock, spawns, minutes
):
    minutes(10)
    _separate(tmp_path, "aaaa")
    first = sep_mod._worker["proc"]

    clock.t += 9 * MIN
    assert await idle_unload.check() == []
    assert first.poll() is None, "not before the idle minutes are up"

    clock.t += 1 * MIN
    assert "separation worker" in await idle_unload.check()
    assert first.poll() is not None, "the process is gone, not just forgotten"
    assert "proc" not in sep_mod._worker

    _separate(tmp_path, "bbbb")
    assert spawns == ["cpu", "cpu"], "the next job started a new worker"
    assert sep_mod._worker["proc"].poll() is None


async def test_beat_model_unloads_when_idle_and_the_next_detection_reloads_it(
    clock, beat_loads, minutes
):
    minutes(10)
    assert bd._detect_model(None, 22050) is not None
    clock.t += 10 * MIN
    assert "beat model" in await idle_unload.check()
    assert bd._model is None

    assert bd._detect_model(None, 22050) == ([0.5, 1.0, 1.5], [0.5])
    assert beat_loads == [1, 1], "loaded again on the next use"


async def test_zero_never_unloads(tmp_path, clock, spawns, beat_loads, minutes):
    minutes(0)
    _separate(tmp_path, "aaaa")
    bd._detect_model(None, 22050)
    clock.t += 7 * 24 * 60 * MIN
    assert await idle_unload.check() == []
    assert sep_mod._worker["proc"].poll() is None
    assert bd._model is not None


async def test_the_timer_does_not_unload_while_the_pipeline_is_busy(
    tmp_path, clock, spawns, minutes, monkeypatch
):
    from app.pipeline import jobqueue

    minutes(10)
    _separate(tmp_path, "aaaa")
    clock.t += 60 * MIN
    monkeypatch.setattr(jobqueue, "_running_id", "running00000")
    assert await idle_unload.check() == []
    monkeypatch.setattr(jobqueue, "_running_id", None)
    assert await idle_unload.check() == [], "idle counts from when it went quiet"
    assert sep_mod._worker["proc"].poll() is None


# --- a cancel during an unload --------------------------------------------------


def _hold_unload(monkeypatch) -> tuple[threading.Thread, threading.Event]:
    """Start an idle unload that stays inside the worker's lock until released."""
    entered, release = threading.Event(), threading.Event()
    real_kill = sep_mod._kill_worker

    def slow_kill() -> None:
        entered.set()
        release.wait(10)
        real_kill()

    monkeypatch.setattr(sep_mod, "_kill_worker", slow_kill)
    unloader = threading.Thread(target=sep_mod.WORKER.unload_if_idle, args=(10 * MIN,))
    unloader.start()
    assert entered.wait(5)
    monkeypatch.setattr(sep_mod, "_kill_worker", real_kill)
    return unloader, release


def test_a_cancel_during_an_unload_stays_a_cancel(tmp_path, clock, spawns, monkeypatch):
    _separate(tmp_path, "aaaa")
    clock.t += 60 * MIN
    unloader, release = _hold_unload(monkeypatch)

    job = Job(id="eeeeeeeeeeee", status="separating")
    (tmp_path / "source.wav").write_bytes(b"RIFF")
    raised: list[BaseException] = []

    def run() -> None:
        try:
            sep_mod.separate(job, tmp_path / "source.wav", tmp_path)
        except BaseException as e:
            raised.append(e)

    t = threading.Thread(target=run)
    t.start()
    t.join(0.3)
    assert t.is_alive(), "the job waits for the unload"
    job.cancel_requested = True
    release.set()
    unloader.join(10)
    t.join(10)
    assert raised and isinstance(raised[0], JobCancelled)
    assert not (tmp_path / "htdemucs_6s").exists(), "the cancelled job separated nothing"
    assert spawns == ["cpu"], "no worker was started for it"
    assert sep_mod.WORKER._users == 0


# --- a worker that will not stop -------------------------------------------------


class Wedged:
    """A worker that ignores terminate() and kill()."""

    def __init__(self) -> None:
        self.pid = 4242
        self.calls: list[str] = []
        self.exited = False
        self.stdin = None
        self.stderr = None

    def poll(self):
        return 0 if self.exited else None

    def terminate(self) -> None:
        self.calls.append("terminate")

    def kill(self) -> None:
        self.calls.append("kill")

    def wait(self, timeout=None):
        self.calls.append(f"wait {timeout}")
        raise subprocess.TimeoutExpired("demucs", timeout)

    def communicate(self, *a, **k):
        raise AssertionError("an unbounded reap")


@pytest.fixture()
def wedged(monkeypatch) -> Wedged:
    monkeypatch.setattr(sep_mod, "WORKER_KILL_REAP_TIMEOUT_SEC", 0.01)
    w = Wedged()
    sep_mod._worker.update(proc=w, device="cuda")
    return w


def test_a_worker_that_will_not_die_is_given_up_on_after_a_bounded_wait(wedged, caplog):
    sep_mod._kill_worker()
    assert wedged.calls == ["terminate", "wait 5", "kill", "wait 0.01"]
    assert "did not exit" in caplog.text
    assert "proc" not in sep_mod._worker
    assert [(e.proc, e.device) for e in sep_mod._left_behind] == [(wedged, "cuda")]


def test_no_gpu_worker_beside_a_left_behind_one(wedged, tmp_path, spawns, monkeypatch):
    sep_mod._kill_worker()
    monkeypatch.setattr(sep_mod, "get_demucs_device", lambda: "cuda")
    job = _separate(tmp_path, "gggg")
    assert spawns == ["cpu"], "no cuda worker was started beside it"
    assert job.gpu_fallback is True
    assert wedged.calls[-1] == "kill", "killed once more"

    wedged.exited = True
    _separate(tmp_path, "hhhh")
    assert spawns == ["cpu", "cuda"], "the GPU is used again once it has exited"
    assert sep_mod._left_behind == []


def test_a_leftover_that_never_exits_stops_blocking_the_gpu(wedged, tmp_path, spawns, monkeypatch):
    sep_mod._kill_worker()
    monkeypatch.setattr(sep_mod, "get_demucs_device", lambda: "cuda")
    for name in ("j1", "j2", "j3"):
        assert _separate(tmp_path, name).gpu_fallback is True
    assert _separate(tmp_path, "j4").gpu_fallback is not True
    assert spawns[-1] == "cuda"
    assert [e.proc for e in sep_mod._left_behind] == [wedged], "still tracked for shutdown"


def test_shutdown_kills_a_left_behind_worker_once_more(wedged, caplog):
    sep_mod._kill_worker()
    before = len(wedged.calls)
    sep_mod.shutdown_worker()
    assert wedged.calls[before:] == ["kill"]
    assert "still running at shutdown" in caplog.text


# --- the setting ---------------------------------------------------------------


def test_setting_defaults_to_ten_and_clamps():
    assert settings.get_idle_unload_minutes() == 10
    assert settings.set_idle_unload_minutes(0) == (0, True)
    assert settings.get_idle_unload_minutes() == 0
    assert settings.set_idle_unload_minutes(10**6) == (1440, True)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [("", 10), ("0", 0), ("30", 30), ("-3", 0), ("99999", 1440), ("ten", 10)],
)
def test_the_environment_seeds_the_default(monkeypatch, raw, expected):
    monkeypatch.setenv("STEMDECK_IDLE_UNLOAD_MINUTES", raw)
    assert settings.get_idle_unload_minutes() == expected


def test_a_saved_value_wins_over_the_environment(monkeypatch):
    monkeypatch.setenv("STEMDECK_IDLE_UNLOAD_MINUTES", "45")
    settings.set_idle_unload_minutes(5)
    assert settings.get_idle_unload_minutes() == 5


@pytest.fixture()
def client():
    import app.main as main_mod

    with TestClient(main_mod.app) as c:
        yield c


def test_settings_api_round_trips_it(client):
    got = client.get("/api/settings").json()
    assert got["idle_unload_minutes"] == 10
    assert got["idle_unload_minutes_max"] == 1440

    r = client.post("/api/settings", json={"idle_unload_minutes": 3})
    assert r.status_code == 200 and r.json()["idle_unload_minutes"] == 3
    assert client.get("/api/settings").json()["idle_unload_minutes"] == 3
    settings._state = None
    assert client.get("/api/settings").json()["idle_unload_minutes"] == 3, "on disk"

    r = client.post("/api/settings", json={"idle_unload_minutes": 0})
    assert r.status_code == 200 and r.json()["idle_unload_minutes"] == 0


@pytest.mark.parametrize("raw", [True, "5", -1, 5.5, None])
def test_settings_api_refuses_a_value_that_is_not_whole_minutes(client, raw):
    client.post("/api/settings", json={"idle_unload_minutes": 7})
    r = client.post("/api/settings", json={"idle_unload_minutes": raw})
    assert r.status_code == 422
    assert client.get("/api/settings").json()["idle_unload_minutes"] == 7


def test_settings_api_answers_an_error_when_the_value_cannot_be_saved(client, monkeypatch):
    client.post("/api/settings", json={"idle_unload_minutes": 7})
    monkeypatch.setattr(settings, "_atomic_write_json", lambda path, data: False)
    r = client.post("/api/settings", json={"idle_unload_minutes": 30})
    assert r.status_code == 500
    assert "idle_unload_minutes" in r.json()["detail"]
    assert client.get("/api/settings").json()["idle_unload_minutes"] == 7, "the value in use"
