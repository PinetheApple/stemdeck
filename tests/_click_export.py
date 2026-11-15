"""Shared by the click export tests (test_click_sounds_api.py,
test_click_stem_zip.py): a done job with noise stems and a beat grid, the
registry and client fixtures, and readers for what the routes return.

Each test module imports the fixtures, which is how pytest finds them there;
they are named `client` and `jobs_dir` by their decorators, so the imported
names do not clash with the tests' arguments.
"""

from __future__ import annotations

import io
import json
import wave
import zipfile
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf

from app.core import config
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import click_sounds as cs

SR = 44100
JOB = "c1c2c3c4c5c6"
STEM_SECONDS = 3.3  # deliberately not the grid's 3.0: the stems decide the length
# "tempo": null means analysis found no tempo, so the app clicks these beats as
# they stand instead of fitting and continuing them over the song.
GRID = {
    "version": 1,
    "beats": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0],
    "bars": [{"beat": 0, "beats_per_bar": 4}],
    "duration": 3.0,
    "tempo": None,
}
LIVE_LEVEL_TOLERANCE_DB = 0.05
INT16_LSB = 1 / 32767
FFMPEG_TIMEOUT_S = 60


@pytest.fixture(autouse=True)
def isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture(name="jobs_dir")
def jobs_dir_fixture() -> Path:
    return config.JOBS_DIR


@pytest.fixture(name="client")
def client_fixture(jobs_dir):
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def make_job(jobs_dir: Path, names=("vocals", "drums"), grid=True) -> Job:
    job = Job(id=JOB, status="done", title="Clicky", duration_sec=STEM_SECONDS)
    stems = jobs_dir / JOB / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(3)
    n = int(round(STEM_SECONDS * SR))
    for name in names:
        noise = (rng.standard_normal((n, 2)) * 0.05).clip(-1, 1)
        sf.write(stems / f"{name}.wav", noise, SR, subtype="PCM_16")
        job.stems.append({"name": name, "url": f"/api/jobs/{JOB}/stems/{name}.wav"})
    if grid:
        (stems / "beats.json").write_text(json.dumps(GRID), encoding="utf-8")
    _jobs[job.id] = job
    return job


def read_zip(content: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(content))


def read_wav(content: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(content), "rb") as w:
        n = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(float) / 32767.0
    return data.reshape(-1, n)


def live_click(level: int, gain: float) -> np.ndarray:
    """The live Classic click on one channel: the browser's buffer times the volume."""
    return cs.render_voice("classic", level, SR) * gain


def db(a: np.ndarray, b: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(a**2)) / np.sqrt(np.mean(b**2))))
