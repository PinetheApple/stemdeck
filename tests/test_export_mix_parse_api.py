"""The export mix parsing every mix route shares (stems.parse_export_mix).

- Mixdown checks the click sound and the trim range before it parses the
  lanes, so a request with several bad params gets those 422s first.
- The loudness route drops a take lane's pitch as the export does, so a take
  never asks for a transpose this ffmpeg cannot do; a stem lane still does.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import stems as stems_mod
from app.api.stems import NO_TRANSPOSE_DETAIL
from app.core.config import MASTER_PRESET_CEILING_DBTP
from app.core.registry import _jobs
from app.pipeline import master_plan_cache
from app.pipeline.eq_targets import get_target
from app.pipeline.mastering import MasterSettings, encode_master_param
from tests._takes_helpers import JOB, add_done_job
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_master_takes_export import _loud_take
from tests.test_takes_export import _tone_stem

BASE = f"/api/jobs/{JOB}"
BAD_GAINS = "stems=drums&gains=x"
STREAMING = encode_master_param(
    MasterSettings(get_target("mix.balanced").target_lufs, MASTER_PRESET_CEILING_DBTP)
)
SHIFT = 2


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    _jobs.clear()
    monkeypatch.setattr(master_plan_cache, "MASTER_PLAN_CACHE_DIR", tmp_path / "_master")
    add_done_job(cfg.JOBS_DIR)
    yield
    _jobs.clear()


@pytest.fixture
def client() -> TestClient:
    from app.main import app

    return TestClient(app)


@pytest.mark.parametrize(
    ("extra", "detail"),
    [
        ("&click_sound=nope", "unknown click sound"),
        ("&start=5&end=1", "start and end are both required and start must be less than end"),
        ("&start=0&end=9999", "end is beyond the end of the track"),
        ("", "gains must be numbers"),
    ],
    ids=["click-sound", "trim-order", "trim-range", "gains-alone"],
)
def test_mixdown_checks_click_and_trim_before_the_lanes(client, extra, detail):
    r = client.get(f"{BASE}/mixdown.wav?{BAD_GAINS}{extra}")
    assert r.status_code == 422
    assert r.json()["detail"] == detail


def test_an_unknown_stem_with_a_bad_click_sound_gets_the_click_sound_422(client):
    r = client.get(f"{BASE}/mixdown.wav?stems=bogus&gains=1&click_sound=nope")
    assert r.status_code == 422
    assert r.json()["detail"] == "unknown click sound"


def _no_rubberband(monkeypatch) -> None:
    monkeypatch.setattr(stems_mod, "_rubberband_available", lambda: False)


def test_the_loudness_route_drops_a_take_lanes_pitch(client, monkeypatch):
    skip_without_ffmpeg()
    _tone_stem("bass")
    take = _loud_take(client)
    _no_rubberband(monkeypatch)
    query = f"stems=bass,{take}&gains=1,1&pitches=0,{SHIFT}&master={STREAMING}"
    r = client.get(f"{BASE}/mixdown/loudness?{query}")
    assert r.status_code == 200, r.text


def test_the_loudness_route_still_refuses_a_stem_transpose(client, monkeypatch):
    _tone_stem("bass")
    _no_rubberband(monkeypatch)
    query = f"stems=bass&gains=1&pitches={SHIFT}&master={STREAMING}"
    r = client.get(f"{BASE}/mixdown/loudness?{query}")
    assert r.status_code == 422
    assert r.json()["detail"] == NO_TRANSPOSE_DETAIL
