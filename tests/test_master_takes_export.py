"""A take lane under the master: the loudness plan measures the same sum the
export renders, take limiter included, so the planned loudness is the one heard."""

from __future__ import annotations

import asyncio

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import export_fx
from app.api import stems as stems_mod
from app.core.config import MASTER_CORRECTION_TOL_LU
from app.core.registry import _jobs
from app.core.settings import get_export_sample_rate
from app.pipeline import master_plan_cache
from app.pipeline.mastering import MasterSettings, encode_master_param
from tests._takes_helpers import CAPTURE_RATE, JOB, add_done_job, new_take, new_track, put_part
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_takes_export import _tone_stem

BASE = f"/api/jobs/{JOB}"
STREAMING = encode_master_param(MasterSettings(-14.0, -1.0))
TAKE_HZ = 330
TAKE_AMPLITUDE = 0.9
# The decoded measurement's own rounding, on top of the plan's tolerance.
MEASURE_SLACK_LU = 0.1


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    skip_without_ffmpeg()
    _jobs.clear()
    monkeypatch.setattr(master_plan_cache, "MASTER_PLAN_CACHE_DIR", tmp_path / "_master")
    yield
    _jobs.clear()


def _loud_take(client: TestClient) -> str:
    track = new_track(client)
    take_id = new_take(client, track)
    t = np.arange(CAPTURE_RATE) / CAPTURE_RATE
    tone = (TAKE_AMPLITUDE * np.sin(2 * np.pi * TAKE_HZ * t)).astype(np.float32)
    put_part(client, take_id, 0, tone.tobytes())
    assert client.post(f"{BASE}/takes/{take_id}/finish", json={}).status_code == 200
    return take_id


def test_the_plan_with_a_take_in_the_mix_is_the_loudness_rendered():
    from app.main import app

    add_done_job(cfg.JOBS_DIR)
    _tone_stem("drums")
    client = TestClient(app)
    query = f"stems=drums,{_loud_take(client)}&gains=1.0,1.0&master={STREAMING}"
    plan = client.get(f"{BASE}/mixdown/loudness?{query}")
    assert plan.status_code == 200, plan.text
    assert client.get(f"{BASE}/mixdown.wav?{query}").status_code == 200
    [rendered] = stems_mod._MIXDOWN_CACHE_DIR.glob("*.wav")
    heard = asyncio.run(export_fx.measure_file(str(rendered), get_export_sample_rate()))
    assert abs(heard.i - plan.json()["post"]["i"]) <= MASTER_CORRECTION_TOL_LU + MEASURE_SLACK_LU
