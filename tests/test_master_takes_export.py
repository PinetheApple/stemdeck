"""A take lane under the master: the plan measures the sum the export renders,
take limiter (and the click it limits) included, so the planned loudness is heard."""

from __future__ import annotations

import asyncio

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import export_fx, takes_lanes
from app.api import stems as stems_mod
from app.core.config import MASTER_CORRECTION_TOL_LU
from app.core.registry import _jobs
from app.core.settings import get_export_sample_rate
from app.core.takes_config import TAKE_RATE
from app.pipeline import master_plan_cache
from app.pipeline.mastering import MasterSettings, encode_master_param
from tests._takes_helpers import (
    CAPTURE_RATE,
    JOB,
    SONG_SEC,
    add_done_job,
    new_take,
    new_track,
    put_part,
)
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_takes_export import _tone_stem

BASE = f"/api/jobs/{JOB}"
STREAMING = encode_master_param(MasterSettings(-14.0, -1.0))
TAKE_HZ = 330
TAKE_AMPLITUDE = 0.9
# The decoded measurement's own rounding, on top of the plan's tolerance.
MEASURE_SLACK_LU = 0.1
CLICK_EVERY_SEC = 0.25
CLICK_SEC = 0.06
CLICK_HZ = 1000
CLICK_AMPLITUDE = 0.9
CLICK_GAIN = 1.0
# The music under the click is quiet, so the click is much of what is heard.
QUIET_STEM_GAIN = 0.05


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


def _loud_click(monkeypatch) -> None:
    """A dense, loud click track over the whole song, as the export's click lane."""
    t = np.arange(TAKE_RATE * SONG_SEC) / TAKE_RATE
    on = (t % CLICK_EVERY_SEC) < CLICK_SEC
    pulses = (CLICK_AMPLITUDE * on * np.sin(2 * np.pi * CLICK_HZ * t)).astype(np.float32)
    path = cfg.JOBS_DIR / JOB / "click.wav"
    sf.write(str(path), pulses, TAKE_RATE, subtype="PCM_16")
    lane = stems_mod._ClickLane(path, CLICK_GAIN, 0.0, False)
    monkeypatch.setattr(stems_mod, "_click_lane", lambda *a, **k: lane)


def test_a_loud_click_through_the_take_limiter_is_in_the_plan(monkeypatch):
    from app.main import app

    add_done_job(cfg.JOBS_DIR)
    _tone_stem("drums")
    _loud_click(monkeypatch)
    client = TestClient(app)
    query = (
        f"stems=drums,{_loud_take(client)}&gains={QUIET_STEM_GAIN},1.0&click=1&master={STREAMING}"
    )
    r = client.get(f"{BASE}/mixdown.wav?{query}")
    assert r.status_code == 200, r.text
    planned = float(r.headers["x-stemdeck-loudness-post"].split(";")[0].removeprefix("i="))
    [rendered] = stems_mod._MIXDOWN_CACHE_DIR.glob("*.wav")
    heard = asyncio.run(export_fx.measure_file(str(rendered), get_export_sample_rate()))
    assert abs(heard.i - planned) <= MASTER_CORRECTION_TOL_LU + MEASURE_SLACK_LU


def test_the_measurement_sums_as_the_render_does():
    limiter = takes_lanes.EXPORT_LIMITER
    assert export_fx.measurement_graph(["volume=0.5"], ["drums"], "") == (
        "[0:a]volume=0.5[a0];[a0]anull[pre]"
    )
    assert export_fx.measurement_graph(["anull", "volume=2"], ["a", "b"], "biquad=b0=1.0,") == (
        "[0:a]anull[a0];[1:a]volume=2[a1];"
        "[a0][a1]amix=inputs=2:normalize=0[mix];[mix]biquad=b0=1.0,anull[pre]"
    )
    graph = export_fx.measurement_graph(["anull"], ["t00000001"], "", "volume=1.0")
    assert graph == (
        "[0:a]anull[a0];[1:a]volume=1.0[a1];"
        f"[a0][a1]amix=inputs=2:normalize=0,{limiter}[mix];[mix]anull[pre]"
    )
