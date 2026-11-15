"""POST .../versions/extract on a song missing stems: only the absent ones move
in. The separator is stubbed; endpoints, task, lock, trash and delete are real."""

from __future__ import annotations

import io
import os
import threading
import time
import wave
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api.versions import EXTRACT_RUNNING, SOURCE_GONE
from app.core.config import DEMUCS_MODEL, MAX_VERSIONS_PER_SONG, STEM_NAMES
from app.core.models import STATUS_DONE, Job, JobBusy, JobCancelled, _set
from app.core.registry import _jobs, set_proc
from app.core.stem_files import WAV_EXT
from app.core.versions import DEFAULT_VERSION_ID
from app.pipeline import extract_stems as ex_mod
from app.pipeline.collect import sweep_crash_leftovers
from app.pipeline.errors import CAUSE_OUT_OF_MEMORY, SeparationError
from app.pipeline.runs import CANCELLED, DONE, FAILED, IDLE, RUNNING
from tests.test_lyrics_retime_api import _release, hold_the_lock
from tests.test_versions_api import JOB_ID, SELECTED, _done, _meta, _stems_dir

EXTRACT = f"/api/jobs/{JOB_ID}/versions/extract"
CANCEL = f"{EXTRACT}/cancel"
WAIT_SEC = 10
POLL_SEC = 0.02
OLD_MTIME = 1_000_000_000
TONE_RATE = 8000
TONE_FRAMES = 800
TONE_LEVEL = 8000
REFERENCE_PRESENCE = 50
# Laid out unlike json.dumps, so any rewrite of the file shows.
OLD_PEAKS = b'{\n  "vocals": [[0.0, 0.5]]\n}\n'
# What separate() writes on the job it is given.
SEPARATOR_STATUS = "separating"
# classify_failure's cause for unreadable input, a bare string in errors.py.
BAD_INPUT = "bad-input"

_stubbed: list[FakeSeparator] = []


@pytest.fixture(autouse=True)
def _isolate():
    _jobs.clear()
    ex_mod.EXTRACT_RUNS.runs.clear()
    yield
    _jobs.clear()
    ex_mod.EXTRACT_RUNS.runs.clear()


@pytest.fixture
def client():
    with patch("app.api.jobs.jobqueue.enqueue", lambda job_id: None):
        from app.main import app

        with TestClient(app) as c:
            yield c
            # A test that failed while a fake still blocks would hang the shutdown.
            for fake in _stubbed:
                fake.release.set()
            _stubbed.clear()


class FakeSeparator:
    """separate(): reports half way as the real one does, then waits for a
    release or a kill. Also the "process" the cancel route terminates."""

    def __init__(
        self,
        produce: tuple[str, ...] = STEM_NAMES,
        error: Exception | None = None,
        audio: bytes | None = None,
    ):
        self.produce = produce
        self.audio = audio
        self.error = error
        self.release = threading.Event()
        self.started = threading.Event()
        self.killed = threading.Event()
        self.jobs: list[Job] = []
        self.dirs: list[Path] = []
        self.flag_at_kill: bool | None = None

    def __call__(self, job: Job, source: Path, job_dir: Path) -> Path:
        self.jobs.append(job)
        self.dirs.append(job_dir)
        _set(job, status=SEPARATOR_STATUS, progress=0.5)
        if self.error is not None:
            raise self.error
        set_proc(job.id, self)
        self.started.set()
        try:
            self._wait(job)
        finally:
            set_proc(job.id, None)
        return self._write(source, job_dir)

    def _wait(self, job: Job) -> None:
        while not self.release.wait(POLL_SEC):
            if self.killed.is_set():
                if job.cancel_requested:
                    raise JobCancelled()
                raise SeparationError("demucs failed: worker died")

    def _write(self, source: Path, job_dir: Path) -> Path:
        out = job_dir / DEMUCS_MODEL / source.stem
        out.mkdir(parents=True)
        for name in self.produce:
            (out / f"{name}{WAV_EXT}").write_bytes(self.audio or f"NEW {name}".encode())
        return out

    def poll(self) -> int | None:
        return 1 if self.killed.is_set() else None

    def terminate(self) -> None:
        self.flag_at_kill = self.jobs[-1].cancel_requested
        self.killed.set()


def song(*gone: str, source: bool = True) -> Job:
    job = _done()
    for name in gone:
        stem_file(name).unlink()
    for path in _stems_dir().iterdir():
        os.utime(path, (OLD_MTIME, OLD_MTIME))
    if source:
        (cfg.JOBS_DIR / JOB_ID / f"source{WAV_EXT}").write_bytes(b"RIFF source")
    return job


def tone() -> bytes:
    """A short mono WAV whose every sample is +/- TONE_LEVEL."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TONE_RATE)
        frames = [TONE_LEVEL if i % 2 else -TONE_LEVEL for i in range(TONE_FRAMES)]
        w.writeframes(b"".join(v.to_bytes(2, "little", signed=True) for v in frames))
    return buf.getvalue()


def song_with_presence() -> Job:
    job = song("guitar")
    stem_file("vocals").write_bytes(tone())
    job.stem_presence = {"vocals": REFERENCE_PRESENCE}
    return job


def full_versions() -> list[dict]:
    return [
        {"id": f"v{i}", "name": f"V{i}", "stems": ["bass"], "created_at": float(i)}
        for i in range(MAX_VERSIONS_PER_SONG)
    ]


def stem_file(name: str) -> Path:
    return _stems_dir() / f"{name}{WAV_EXT}"


def stub(monkeypatch, fake: FakeSeparator) -> FakeSeparator:
    monkeypatch.setattr(ex_mod, "separate", fake)
    _stubbed.append(fake)
    return fake


def extract(client, stems=("guitar",)):
    body = {"from": DEFAULT_VERSION_ID, "stems": list(stems), "name": "+ Guitar"}
    return client.post(EXTRACT, json=body)


def wait_ended(client) -> dict:
    deadline = time.monotonic() + WAIT_SEC
    while True:
        body = client.get(EXTRACT).json()
        if body["state"] != RUNNING or time.monotonic() > deadline:
            return body
        time.sleep(POLL_SEC)


def snapshot() -> dict[str, tuple[bytes, float]]:
    return {p.name: (p.read_bytes(), p.stat().st_mtime) for p in _stems_dir().iterdir()}


def contents() -> dict[str, bytes]:
    return {name: data for name, (data, _) in snapshot().items()}


def temps() -> list[str]:
    return [p.name for p in _stems_dir().iterdir() if p.name.startswith(".")]


def assert_unchanged(job: Job, before: dict[str, tuple[bytes, float]]) -> None:
    assert snapshot() == before
    assert job.versions is None
    assert job.status == STATUS_DONE


# ── running ──


def test_a_missing_stem_starts_a_run_and_the_song_stays_done(client, monkeypatch):
    job = song("guitar")
    fake = stub(monkeypatch, FakeSeparator())

    r = extract(client)

    assert r.status_code == 202
    body = r.json()
    assert body["extracting"]["state"] == RUNNING
    assert body["extracting"]["stems"] == ["guitar"]
    assert body["versions"][0]["id"] == DEFAULT_VERSION_ID
    assert fake.started.wait(WAIT_SEC)
    view = client.get(EXTRACT).json()
    assert view["phase"] == ex_mod.PHASE_SEPARATING
    assert view["progress"] == 0.5
    assert job.status == STATUS_DONE
    assert job.versions is None
    fake.release.set()
    wait_ended(client)


def test_done_moves_in_only_the_missing_stem_and_opens_the_version(client, monkeypatch):
    job = song("guitar")
    before = snapshot()
    fake = stub(monkeypatch, FakeSeparator())
    extract(client)
    fake.release.set()

    view = wait_ended(client)

    assert view["state"] == DONE
    after = snapshot()
    assert after.pop(f"guitar{WAV_EXT}")[0] == b"NEW guitar"
    assert {k: v for k, v in after.items() if k in before} == before
    version = next(v for v in job.versions if v["id"] == view["version_id"])
    assert version["stems"] == [n for n in STEM_NAMES if n in {*SELECTED, "guitar"}]
    assert job.open_version == view["version_id"]
    assert any(s["name"] == "guitar" for s in job.stems)
    assert _meta()["open_version"] == view["version_id"]
    assert temps() == []


def test_a_stem_that_appeared_during_the_run_is_not_overwritten(client, monkeypatch):
    job = song("guitar")
    fake = stub(monkeypatch, FakeSeparator())
    extract(client)
    assert fake.started.wait(WAIT_SEC)
    stem_file("guitar").write_bytes(b"MINE")
    fake.release.set()

    assert wait_ended(client)["state"] == DONE
    assert stem_file("guitar").read_bytes() == b"MINE"
    assert job.versions is not None


def test_a_failed_separation_leaves_the_song_as_it_was(client, monkeypatch):
    job = song("guitar")
    before = snapshot()
    stub(monkeypatch, FakeSeparator(error=SeparationError("CUDA out of memory")))
    extract(client)

    view = wait_ended(client)

    assert view["state"] == FAILED
    assert view["error"] == CAUSE_OUT_OF_MEMORY
    assert_unchanged(job, before)


def test_a_damaged_kept_file_fails_as_bad_input(client, monkeypatch):
    song("guitar")
    error = SeparationError("ffmpeg: Invalid data found when processing input")
    stub(monkeypatch, FakeSeparator(error=error))
    extract(client)

    assert wait_ended(client)["error"] == BAD_INPUT


def test_a_model_without_the_stem_fails_with_no_output(client, monkeypatch):
    job = song("guitar")
    before = snapshot()
    fake = stub(monkeypatch, FakeSeparator(produce=("vocals", "drums", "bass", "other")))
    extract(client)
    fake.release.set()

    view = wait_ended(client)

    assert view["state"] == FAILED
    assert view["error"] == ex_mod.EXTRACT_FAILED_NO_OUTPUT
    assert_unchanged(job, before)


def test_a_failed_move_takes_back_the_stems_already_moved(client, monkeypatch):
    job = song("guitar", "piano")
    before = snapshot()
    fake = stub(monkeypatch, FakeSeparator())
    real_replace = os.replace

    def failing_replace(src, dst, *args, **kwargs):
        if Path(dst) == stem_file("piano"):
            raise OSError("disk went away")
        return real_replace(src, dst, *args, **kwargs)

    monkeypatch.setattr(os, "replace", failing_replace)
    extract(client, stems=("guitar", "piano"))
    fake.release.set()

    assert wait_ended(client)["state"] == FAILED
    assert_unchanged(job, before)
    assert not any(s["name"] in {"guitar", "piano"} for s in job.stems)


def test_the_version_limit_reached_mid_run_fails_and_restores_peaks(client, monkeypatch):
    job = song_with_presence()
    (_stems_dir() / "peaks.json").write_bytes(OLD_PEAKS)
    before = contents()
    fake = stub(monkeypatch, FakeSeparator(audio=tone()))
    extract(client)
    assert fake.started.wait(WAIT_SEC)
    job.versions = full_versions()
    fake.release.set()

    view = wait_ended(client)

    assert view["state"] == FAILED
    assert view["error"] == ex_mod.EXTRACT_FAILED_TOO_MANY_VERSIONS
    assert contents() == before
    assert job.versions == full_versions()
    assert job.stem_presence == {"vocals": REFERENCE_PRESENCE}


def test_a_take_back_that_fails_still_restores_the_song(client, monkeypatch):
    job = song_with_presence()
    stems_before = job.stems
    fake = stub(monkeypatch, FakeSeparator(audio=tone()))

    def full_disk(stems_dir, placed):
        raise OSError("No space left on device")

    monkeypatch.setattr(ex_mod, "_take_back", full_disk)
    extract(client)
    assert fake.started.wait(WAIT_SEC)
    job.versions = full_versions()
    fake.release.set()

    assert wait_ended(client)["state"] == FAILED
    assert job.stems == stems_before
    assert job.stem_presence == {"vocals": REFERENCE_PRESENCE}
    assert not (_stems_dir() / "peaks.json").exists()


def test_an_extracted_stem_gets_presence_on_the_songs_scale(client, monkeypatch):
    job = song_with_presence()
    fake = stub(monkeypatch, FakeSeparator(audio=tone()))
    extract(client)
    fake.release.set()

    assert wait_ended(client)["state"] == DONE
    assert job.stem_presence == {"vocals": REFERENCE_PRESENCE, "guitar": REFERENCE_PRESENCE}


# ── cancel, trash, delete ──


def test_cancel_sets_the_flag_before_the_kill_and_leaves_the_song(client, monkeypatch):
    job = song("guitar")
    before = snapshot()
    fake = stub(monkeypatch, FakeSeparator())
    extract(client)
    assert fake.started.wait(WAIT_SEC)

    r = client.post(CANCEL)

    assert r.status_code == 200
    assert fake.flag_at_kill is True
    assert wait_ended(client)["state"] == CANCELLED
    assert_unchanged(job, before)


def test_a_run_waiting_for_the_lock_is_cancelled_at_once(client, monkeypatch):
    song("guitar")
    fake = stub(monkeypatch, FakeSeparator())
    lock = hold_the_lock(client, monkeypatch)
    extract(client)

    assert client.post(CANCEL).json()["state"] == CANCELLED
    client.portal.call(_release, lock)
    time.sleep(WAIT_SEC * POLL_SEC)
    assert fake.jobs == []


def test_a_second_extract_while_one_runs_is_refused(client, monkeypatch):
    song("guitar", "piano")
    fake = stub(monkeypatch, FakeSeparator())
    extract(client)

    r = extract(client, stems=("piano",))

    assert r.status_code == 409
    assert r.json()["detail"] == EXTRACT_RUNNING
    fake.release.set()
    wait_ended(client)


def test_trashing_the_song_stops_the_run(client, monkeypatch):
    job = song("guitar")
    before = snapshot()
    fake = stub(monkeypatch, FakeSeparator())
    extract(client)
    assert fake.started.wait(WAIT_SEC)
    run = ex_mod.EXTRACT_RUNS.current(JOB_ID)

    assert client.post(f"/api/jobs/{JOB_ID}/trash").status_code == 200

    assert fake.flag_at_kill is True
    assert run.ended.wait(WAIT_SEC)
    assert run.state == CANCELLED
    assert snapshot() == before
    assert job.versions is None


def test_deleting_the_song_waits_for_the_run_to_end(client, monkeypatch):
    song("guitar")
    fake = stub(monkeypatch, FakeSeparator())
    extract(client)
    assert fake.started.wait(WAIT_SEC)
    run = ex_mod.EXTRACT_RUNS.current(JOB_ID)

    assert client.delete(f"/api/jobs/{JOB_ID}").status_code == 200

    assert run.ended.is_set()
    assert ex_mod.EXTRACT_RUNS.current(JOB_ID) is None
    assert not (cfg.JOBS_DIR / JOB_ID).exists()


def test_a_library_move_is_refused_while_a_run_is_going(client, monkeypatch):
    from app.main import _refuse_while_busy

    song("guitar")
    fake = stub(monkeypatch, FakeSeparator())
    extract(client)
    assert fake.started.wait(WAIT_SEC)

    with pytest.raises(JobBusy):
        _refuse_while_busy()
    fake.release.set()
    wait_ended(client)


# ── refusals and restarts ──


def test_without_the_kept_audio_nothing_is_started(client, monkeypatch):
    job = song("guitar", source=False)
    before = snapshot()
    fake = stub(monkeypatch, FakeSeparator())

    r = extract(client)

    assert r.status_code == 409
    assert r.json()["detail"] == SOURCE_GONE
    assert client.get(EXTRACT).json() == {"state": IDLE}
    assert fake.jobs == []
    assert_unchanged(job, before)


def test_a_run_cut_short_by_a_restart_leaves_nothing(client, monkeypatch):
    song("guitar")
    fake = stub(monkeypatch, FakeSeparator())
    extract(client)
    assert fake.started.wait(WAIT_SEC)
    fake.release.set()
    wait_ended(client)
    # What a kill mid-separation leaves: the run's temp folder, half written.
    leftover = fake.dirs[0]
    leftover.mkdir()
    stem_file("guitar").rename(leftover / f"guitar{WAV_EXT}")
    os.utime(leftover, (OLD_MTIME, OLD_MTIME))
    ex_mod.EXTRACT_RUNS.forget(JOB_ID)

    assert sweep_crash_leftovers(cfg.JOBS_DIR, []) == 1
    assert not leftover.exists()
    assert client.get(EXTRACT).json() == {"state": IDLE}


def test_a_song_with_every_stem_file_takes_the_instant_path(client, monkeypatch):
    song()
    fake = stub(monkeypatch, FakeSeparator())

    assert extract(client).status_code == 201
    assert fake.jobs == []
