"""Opt-in MP3 stem storage (#97, upstream PR 822 and 898): the setting, the
stem-path lookup and the storage stage.

- The setting: WAV by default, env seeds it, a saved choice wins, a whitelist
  guards both values and one bad value changes nothing.
- The stage: WAV touches nothing; MP3 replaces the WAVs only after every stem
  decoded to the WAV's exact length and lined up, and only once the MP3s and
  the folder are on the disk; every failure keeps the WAVs; a cancel cleans
  up and raises; the runner never fails a song over it.
- A crash mid-storage leaves only temps the startup sweep removes.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf

from app.core import config, settings
from app.core.models import Job, JobCancelled
from app.core.registry import _jobs
from app.core.stem_files import stem_path
from app.pipeline import collect, stem_storage, stem_verify
from tests.ffmpeg_probe import skip_without_ffmpeg

SR = 44100
SECONDS = 6.0
NAMES = ("vocals", "drums", "bass")
JOB_ID = "abcdef970001"


def _signal(seed: int = 7, seconds: float = SECONDS) -> np.ndarray:
    """Noise bursts on a tone with a click each second: one sharp xcorr peak."""
    rng = np.random.default_rng(seed)
    n = int(SR * seconds)
    t = np.arange(n) / SR
    env = np.where((t % 0.5) < 0.05, 1.0, 0.25)[:, None]
    x = rng.standard_normal((n, 2)) * 0.08 * env + 0.2 * np.sin(2 * np.pi * 220 * t)[:, None]
    for k in range(1, int(seconds)):
        x[k * SR, :] = 0.9
    return x.clip(-1, 1)


def _job(job_id: str = JOB_ID, names=NAMES) -> Job:
    job = Job(id=job_id, status="done", title="Storage", duration_sec=SECONDS)
    stems = config.JOBS_DIR / job_id / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(names):
        sf.write(stems / f"{name}.wav", _signal(seed=i + 1), SR, subtype="PCM_16")
        job.stems.append({"name": name, "url": f"/api/jobs/{job_id}/stems/{name}.wav"})
    job.mix_url = f"/api/jobs/{job_id}/stems/vocals.wav"
    _jobs[job.id] = job
    return job


def _stems(job: Job) -> Path:
    return config.JOBS_DIR / job.id / "stems"


def _store(job: Job, fmt: str = "mp3", kbps: int = 128) -> Path:
    settings.set_stem_storage(fmt, kbps)
    stem_storage.store_stems(job, config.JOBS_DIR / job.id)
    return _stems(job)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("STEMDECK_STEM_FORMAT", raising=False)
    monkeypatch.delenv("STEMDECK_STEM_MP3_KBPS", raising=False)
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client():
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


# ── The setting ──


def test_default_is_wav_with_nothing_saved():
    assert (settings.get_stem_format(), settings.get_stem_mp3_kbps()) == ("wav", 128)


def test_env_seeds_the_default_and_a_saved_choice_wins(monkeypatch):
    monkeypatch.setenv("STEMDECK_STEM_FORMAT", "MP3")
    monkeypatch.setenv("STEMDECK_STEM_MP3_KBPS", "192k")
    assert (settings.get_stem_format(), settings.get_stem_mp3_kbps()) == ("mp3", 192)
    settings.set_stem_storage("wav", 256)
    assert (settings.get_stem_format(), settings.get_stem_mp3_kbps()) == ("wav", 256)


@pytest.mark.parametrize(("fmt", "kbps"), [("flac", "320"), ("", "x"), ("../wav", "128.0")])
def test_env_outside_the_whitelist_falls_back_to_the_default(monkeypatch, fmt, kbps):
    monkeypatch.setenv("STEMDECK_STEM_FORMAT", fmt)
    monkeypatch.setenv("STEMDECK_STEM_MP3_KBPS", kbps)
    assert (settings.get_stem_format(), settings.get_stem_mp3_kbps()) == ("wav", 128)


async def test_settings_endpoint_reads_and_saves_both(client):
    async with client:
        before = (await client.get("/api/settings")).json()
        r = await client.post("/api/settings", json={"stem_format": "mp3", "stem_mp3_kbps": 256})
    assert (before["stem_format"], before["stem_mp3_kbps"]) == ("wav", 128)
    assert r.status_code == 200
    assert (r.json()["stem_format"], r.json()["stem_mp3_kbps"]) == ("mp3", 256)


@pytest.mark.parametrize(
    "body",
    [
        {"stem_format": "flac"},
        {"stem_mp3_kbps": 320},
        {"stem_mp3_kbps": "192"},
        {"stem_mp3_kbps": True},
        {"stem_format": "mp3", "stem_mp3_kbps": 64},
    ],
)
async def test_one_bad_value_is_refused_and_changes_nothing(client, body):
    async with client:
        r = await client.post("/api/settings", json=body)
    assert r.status_code == 422
    assert "one of" in r.json()["detail"]
    assert (settings.get_stem_format(), settings.get_stem_mp3_kbps()) == ("wav", 128)


# ── The lookup ──


def test_lookup_prefers_wav_then_mp3_then_the_missing_wav_path(tmp_path):
    assert stem_path(tmp_path, "vocals") == tmp_path / "vocals.wav"
    (tmp_path / "vocals.mp3").write_bytes(b"x")
    assert stem_path(tmp_path, "vocals") == tmp_path / "vocals.mp3"
    (tmp_path / "vocals.wav").write_bytes(b"x")
    assert stem_path(tmp_path, "vocals") == tmp_path / "vocals.wav"


# ── The stage ──


def test_wav_storage_touches_nothing():
    job = _job()
    before = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in _stems(job).iterdir()}
    stems = _store(job, "wav")
    after = {p.name: (p.stat().st_size, p.stat().st_mtime_ns) for p in stems.iterdir()}
    assert after == before
    assert (job.stem_format, job.stem_mp3_kbps) == ("wav", None)
    assert all(s["url"].endswith(".wav") for s in job.stems)


@pytest.mark.parametrize("kbps", [128, 192, 256])
def test_mp3_storage_is_frame_exact_and_aligned_in_both_decoders(kbps):
    skip_without_ffmpeg()
    job = _job(names=("vocals",))
    wav = _stems(job) / "vocals.wav"
    ref = sf.read(wav, dtype="float32")[0]
    stems = _store(job, kbps=kbps)
    mp3 = stems / "vocals.mp3"
    got = sf.read(mp3, dtype="float32")[0]
    assert got.shape == ref.shape
    assert stem_verify.ffmpeg_frames(job, mp3, 2) == len(ref)
    _zero, _best, lag = stem_verify._correlation(
        ref[:, 0].astype(np.float64), got[:, 0].astype(np.float64), 4096
    )
    assert lag == 0


def test_mp3_storage_replaces_every_stem_and_records_the_job():
    skip_without_ffmpeg()
    job = _job()
    stems = _store(job, kbps=192)
    assert sorted(p.name for p in stems.iterdir()) == sorted(f"{n}.mp3" for n in NAMES)
    assert (job.stem_format, job.stem_mp3_kbps) == ("mp3", 192)
    assert [s["url"] for s in job.stems] == [f"/api/jobs/{job.id}/stems/{n}.mp3" for n in NAMES]
    assert job.mix_url == f"/api/jobs/{job.id}/stems/vocals.mp3"


def _watch_the_disk(monkeypatch) -> list[str]:
    events: list[str] = []
    real_unlink = Path.unlink

    monkeypatch.setattr(
        stem_storage, "fsync_file", lambda p: events.append(f"fsync {Path(p).name}")
    )
    monkeypatch.setattr(stem_storage, "fsync_dir", lambda d: events.append("fsync dir"))

    def unlink(self, missing_ok=False):
        if self.suffix == ".wav":
            events.append(f"unlink {self.name}")
        return real_unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", unlink)
    return events


def test_mp3s_and_the_folder_reach_the_disk_before_any_wav_goes(monkeypatch):
    skip_without_ffmpeg()
    job = _job()
    events = _watch_the_disk(monkeypatch)
    _store(job)
    first_unlink = next(i for i, e in enumerate(events) if e.startswith("unlink"))
    assert events.index("fsync dir") < first_unlink
    assert sum(e.startswith("fsync .") for e in events[:first_unlink]) == len(NAMES)


def test_split_stems_reach_the_disk_before_their_wavs_go(monkeypatch):
    skip_without_ffmpeg()
    job = _job(names=("lead_vocals", "backing_vocals"))
    job.stem_format, job.stem_mp3_kbps = "mp3", 128
    events = _watch_the_disk(monkeypatch)
    stem_storage.store_split_stems(job, _stems(job), ["lead_vocals", "backing_vocals"])
    first_unlink = next(i for i, e in enumerate(events) if e.startswith("unlink"))
    assert events.index("fsync dir") < first_unlink
    assert sorted(p.name for p in _stems(job).iterdir()) == [
        "backing_vocals.mp3",
        "lead_vocals.mp3",
    ]


def _stub_encoder(monkeypatch, code: str) -> None:
    monkeypatch.setattr(
        stem_verify, "encode_cmd", lambda src, dest, kbps: [sys.executable, "-c", code]
    )


def _assert_kept_as_wav(job: Job) -> None:
    assert sorted(p.name for p in _stems(job).iterdir()) == sorted(f"{n}.wav" for n in NAMES)
    assert (job.stem_format, job.stem_mp3_kbps) == ("wav", None)
    assert all(s["url"].endswith(".wav") for s in job.stems)


def test_an_encoder_that_fails_keeps_the_wavs(monkeypatch):
    job = _job()
    _stub_encoder(monkeypatch, "raise SystemExit(1)")
    _store(job)
    _assert_kept_as_wav(job)


def test_a_corrupt_output_keeps_the_wavs(monkeypatch):
    job = _job()
    monkeypatch.setattr(
        stem_verify,
        "encode_cmd",
        lambda src, dest, kbps: [sys.executable, "-c", f"open({str(dest)!r}, 'wb').write(b'x')"],
    )
    _store(job)
    _assert_kept_as_wav(job)


@pytest.mark.parametrize("shift", [1105, 2000])
def test_a_shifted_output_keeps_the_wavs(monkeypatch, shift):
    skip_without_ffmpeg()
    job = _job()
    real_cmd = stem_verify.encode_cmd

    def shifted(src, dest, kbps):
        data, rate = sf.read(src, dtype="float32")
        moved = Path(str(src) + ".shifted.wav")
        sf.write(moved, np.roll(data, shift, axis=0), rate, subtype="PCM_16")
        return real_cmd(moved, dest, kbps)

    monkeypatch.setattr(stem_verify, "encode_cmd", shifted)
    _store(job)
    for leftover in _stems(job).glob("*.shifted.wav"):
        leftover.unlink()
    _assert_kept_as_wav(job)


def test_a_failed_move_keeps_the_wavs_and_leaves_no_mp3(monkeypatch):
    skip_without_ffmpeg()
    job = _job()
    real_replace = os.replace
    calls = []

    def flaky(src, dst):
        calls.append(dst)
        if len(calls) == 2:
            raise OSError("disk full")
        real_replace(src, dst)

    monkeypatch.setattr(stem_storage.os, "replace", flaky)
    _store(job)
    _assert_kept_as_wav(job)


def test_a_cancel_mid_encode_cleans_up_and_raises(monkeypatch):
    skip_without_ffmpeg()
    job = _job()
    real_encode = stem_verify.encode_mp3

    def encode_then_cancel(job_, src, dest, kbps):
        real_encode(job_, src, dest, kbps)
        job_.cancel_requested = True

    monkeypatch.setattr(stem_storage, "encode_mp3", encode_then_cancel)
    settings.set_stem_storage("mp3", 128)
    with pytest.raises(JobCancelled):
        stem_storage.store_stems(job, config.JOBS_DIR / job.id)
    assert sorted(p.name for p in _stems(job).iterdir()) == sorted(f"{n}.wav" for n in NAMES)


async def test_a_late_cancel_leaves_a_finished_wav_song_done():
    from app.pipeline import runner

    job = _job()
    job.status = "processing"

    def finish_then_cancel(job_, job_dir):
        runner._mark_stems_complete(job_, job_dir)
        job_.cancel_requested = True
        runner._store_stems(job_, job_dir)

    await runner._run_async(job, config.JOBS_DIR / job.id, config.JOBS_DIR, finish_then_cancel)
    assert job.status == "done"
    assert job.stem_format == "wav"
    assert "store" not in (job.stage_timings or {})


def test_the_runner_never_fails_a_song_over_storage(monkeypatch):
    from app.pipeline import runner

    job = _job()

    def boom(job_, job_dir):
        raise RuntimeError("unexpected")

    monkeypatch.setattr(runner, "store_stems", boom)
    runner._store_stems(job, config.JOBS_DIR / job.id)
    assert (job.stem_format, job.stem_mp3_kbps) == ("wav", None)
    assert "store" in job.stage_timings


def test_a_crash_while_storing_leaves_recovery_the_real_title(monkeypatch):
    from app.core.folder_rebuild import recover_done_job
    from app.core.song_folder import keep_added_time
    from app.pipeline import runner

    job = _job()
    job_dir = config.JOBS_DIR / job.id
    keep_added_time(job, job_dir)
    recovered: list[Job | None] = []
    monkeypatch.setattr(runner, "_prepare_local_source", lambda job_, src, dir_: src)
    monkeypatch.setattr(runner, "_run_with_band_lookup", lambda job_, src, dir_: None)
    monkeypatch.setattr(
        runner, "store_stems", lambda job_, dir_: recovered.append(recover_done_job(dir_))
    )
    runner._run_local_blocking(job, job_dir / "source.wav", job_dir)
    assert recovered[0] is not None
    assert recovered[0].title == "Storage"


def test_a_crash_mid_storage_leaves_only_temps_the_startup_sweep_removes():
    job = _job()
    (config.JOBS_DIR / job.id / "metadata.json").write_text("{}", encoding="utf-8")
    temp = stem_storage.temp_mp3_path(_stems(job) / "vocals.wav")
    temp.write_bytes(b"half an mp3")
    old = time.time() - config.TEMP_MIN_AGE_SECONDS - 1
    os.utime(temp, (old, old))
    gone = collect.sweep_crash_leftovers(config.JOBS_DIR, [])
    assert gone == 1
    assert not temp.exists()
    assert sorted(p.name for p in _stems(job).iterdir()) == sorted(f"{n}.wav" for n in NAMES)
