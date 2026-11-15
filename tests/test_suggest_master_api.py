"""GET /api/jobs/{id}/suggest/master.

- Validation before any ffmpeg: a bad or unknown job, a lane the job lacks and
  an unfinished job are 404; bad stems, gains, pitches, fx, target or mode are 422.
- The answer is the lane route's shape plus ``master``, fitted on the mix as
  the export sums it (no master EQ), measured once for every target and mode.
- Merge mode fits the mix through the current master EQ and returns only new bands.
- No boost where the mix has no content.
- A take in the mix is measured through the take limiter, as the export renders it.
- A mix too quiet is refused with 422 "not enough signal".
"""

from __future__ import annotations

import base64
import json

import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import suggest as suggest_mod
from app.core.config import MASTER_PRESET_CEILING_DBTP, SUGGEST_MAX_BANDS_LANE
from app.core.registry import _jobs
from app.pipeline import eq_analysis as A
from app.pipeline import eq_fit as F
from app.pipeline import master_plan_cache
from app.pipeline.eq_suggest import NOT_ENOUGH_SIGNAL, recommend_master
from app.pipeline.eq_targets import get_target
from app.pipeline.fx_filters import Band
from app.pipeline.mastering import MasterSettings, encode_master_param
from tests._takes_helpers import CAPTURE_RATE, SONG_SEC, add_done_job, new_take, new_track, put_part
from tests._takes_helpers import JOB as TAKE_JOB
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_eq_suggest import BALANCED, _dull_top_then_cutoff, shaped_noise
from tests.test_suggest_api import JOB, SECONDS, SR, _job

BASE = f"/api/jobs/{JOB}/suggest/master"
LANE_KEYS = {"bands", "out", "reasons", "loudness", "target", "targets", "target_curve"}
MASTER_KEYS = {"preset", "target_lufs", "ceiling_dbtp", "comp"}
MASTER_WHY = "suggest.why.master."
BUMP_250 = Band("bell", 250.0, 6.0, 1.0, 12)
CUT_250 = ["bell", 250, -6.0, 1.0, 12]
STREAMING_LUFS = get_target("mix.balanced").target_lufs
STREAMING = encode_master_param(MasterSettings(STREAMING_LUFS, MASTER_PRESET_CEILING_DBTP))
# The reason's one-decimal rounding on top of the meter's own.
PARITY_DB = 0.1
HOT_TAKE_GAIN = 4.0
TAKE_HZ = 330
TAKE_AMPLITUDE = 0.9
QUIET_DB = -60.0


def fx_master(*bands: list) -> str:
    body = {"v": 1, "lanes": {}, "master": [{"id": "eq", "out": 0, "b": list(bands)}]}
    raw = json.dumps(body).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    _jobs.clear()
    monkeypatch.setattr(suggest_mod, "SUGGEST_CACHE_DIR", tmp_path / "cache" / "suggest")
    monkeypatch.setattr(master_plan_cache, "MASTER_PLAN_CACHE_DIR", tmp_path / "cache" / "master")
    yield
    _jobs.clear()


@pytest.fixture
def client():
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


@pytest.fixture
def no_ffmpeg(monkeypatch):
    async def refuse(*args, **kwargs):
        raise AssertionError("ffmpeg ran before validation")

    monkeypatch.setattr(suggest_mod, "_run_analysis", refuse)
    monkeypatch.setattr(suggest_mod, "measure_chain", refuse)


@pytest.fixture
def count_runs(monkeypatch):
    calls = []
    real = suggest_mod._run_analysis

    async def counted(source):
        calls.append(source)
        return await real(source)

    monkeypatch.setattr(suggest_mod, "_run_analysis", counted)
    return calls


def _mix(levels=BALANCED, extra=()) -> dict[str, np.ndarray]:
    """Two lanes whose sum has the third-octave shape ``levels``."""
    return {
        "bass": shaped_noise(levels, seconds=SECONDS, seed=1, extra=extra),
        "other": shaped_noise(levels, seconds=SECONDS, seed=2, extra=extra),
    }


BAD = [
    "stems=bass,other&gains=1",
    "stems=nope&gains=1",
    "stems=bass&gains=9",
    "stems=bass&gains=x",
    "stems=bass&gains=1&pitches=x",
    "stems=bass&gains=1&pitches=1,2",
    "stems=bass&gains=1&fx=%25%25%25",
    "stems=bass&gains=1&fx=" + fx_master(["bell", 1e9, 0, 1, 12]),
    "stems=bass&gains=1&target=other.balanced",
    "stems=bass&gains=1&target=nope",
    "stems=bass&gains=1&mode=sideways",
]


@pytest.mark.parametrize("query", BAD)
async def test_bad_input_is_422_before_ffmpeg(client, no_ffmpeg, query):
    _job(cfg.JOBS_DIR, _mix())
    async with client as c:
        r = await c.get(f"{BASE}?{query}")
    assert r.status_code == 422, r.text
    assert "Traceback" not in r.text and str(cfg.JOBS_DIR) not in r.text


@pytest.mark.parametrize(
    "url",
    [
        "/api/jobs/not-a-job/suggest/master?stems=bass&gains=1",
        "/api/jobs/abcdef0f0fff/suggest/master?stems=bass&gains=1",
        "/api/jobs/..%2F..%2Fetc/suggest/master?stems=bass&gains=1",
        f"{BASE}?stems=guitar&gains=1",
    ],
)
async def test_unknown_jobs_and_lanes_are_404(client, no_ffmpeg, url):
    _job(cfg.JOBS_DIR, _mix())
    async with client as c:
        r = await c.get(url)
    assert r.status_code == 404


async def test_a_job_that_is_not_done_is_404(client, no_ffmpeg):
    _job(cfg.JOBS_DIR, _mix())
    _jobs[JOB].status = "running"
    async with client as c:
        r = await c.get(f"{BASE}?stems=bass&gains=1")
    assert r.status_code == 404


async def test_master_suggestion_shape_and_cache(client, count_runs):
    skip_without_ffmpeg()
    _job(cfg.JOBS_DIR, _mix(extra=[BUMP_250]))
    query = f"{BASE}?stems=bass,other&gains=1,1"
    async with client as c:
        r = await c.get(query)
        bright = await c.get(f"{query}&target=mix.bright")
        merged = await c.get(f"{query}&mode=merge&fx={fx_master(CUT_250)}")
    assert r.status_code == bright.status_code == merged.status_code == 200, r.text
    body = r.json()
    assert set(body) == LANE_KEYS | {"master"}
    assert set(body["master"]) == MASTER_KEYS
    assert body["target"] == "mix.balanced" and bright.json()["target"] == "mix.bright"
    assert {t["id"] for t in body["targets"]} == {t.id for t in suggest_mod.targets_for_use("mix")}
    assert body["master"]["ceiling_dbtp"] == MASTER_PRESET_CEILING_DBTP
    free = {s.id for s in F.LAYOUTS[F.FREE]}
    assert 1 <= len(body["bands"]) <= SUGGEST_MAX_BANDS_LANE
    assert all(b["slot"] in free for b in body["bands"])
    [why] = [r for r in body["reasons"] if r["key"].startswith(MASTER_WHY)]
    expected = recommend_master(why["vars"]["i"], why["vars"]["tp"], STREAMING_LUFS)
    assert body["master"]["preset"] == expected.preset
    assert len(count_runs) == 1


async def test_merge_fits_the_mix_through_the_current_master_eq(client):
    skip_without_ffmpeg()
    _job(cfg.JOBS_DIR, _mix(extra=[BUMP_250]))
    query = f"{BASE}?stems=bass,other&gains=1,1"
    async with client as c:
        replaced = (await c.get(query)).json()["bands"]
        merged = (await c.get(f"{query}&mode=merge&fx={fx_master(CUT_250)}")).json()["bands"]
    near_250 = [b for b in replaced if 160 <= b["f"] <= 400 and b["g"] < 0]
    assert near_250
    assert not [b for b in merged if 160 <= b["f"] <= 400 and b["g"] < 0], merged


async def test_no_boost_where_the_mix_has_no_content(client):
    skip_without_ffmpeg()
    lanes = _mix(_dull_top_then_cutoff())
    _job(cfg.JOBS_DIR, lanes)
    async with client as c:
        r = await c.get(f"{BASE}?stems=bass,other&gains=1,1")
    assert r.status_code == 200, r.text
    bands = [Band(b["type"], b["f"], b["g"], b["q"], b["slope"]) for b in r.json()["bands"]]
    spec = A.SpectrumAccumulator()
    spec.feed((lanes["bass"] + lanes["other"]).reshape(-1))
    spec.finish()
    blocked = F.boost_allowed(spec.result().bands, BALANCED) <= 0
    curve = sum((A.band_response_db(b) for b in bands), np.zeros(A.N_BANDS))
    assert blocked.any()
    assert np.max(curve[blocked], initial=0.0) <= F.INAUDIBLE_DB, bands


async def test_a_mix_too_quiet_is_not_enough_signal(client):
    skip_without_ffmpeg()
    quiet = {k: v * 10 ** (QUIET_DB / 20) for k, v in _mix().items()}
    _job(cfg.JOBS_DIR, quiet)
    async with client as c:
        r = await c.get(f"{BASE}?stems=bass,other&gains=1,1")
    assert r.status_code == 422
    assert r.json()["detail"] == NOT_ENOUGH_SIGNAL


def _song_long_take(client: TestClient) -> str:
    """A finished take of a tone as long as the song, so most of it passes the gate."""
    take_id = new_take(client, new_track(client))
    t = np.arange(CAPTURE_RATE * SONG_SEC) / CAPTURE_RATE
    tone = (TAKE_AMPLITUDE * np.sin(2 * np.pi * TAKE_HZ * t)).astype(np.float32)
    assert put_part(client, take_id, 0, tone.tobytes()).status_code == 200
    assert client.post(f"/api/jobs/{TAKE_JOB}/takes/{take_id}/finish", json={}).status_code == 200
    return take_id


def test_a_take_is_measured_as_the_export_renders_it():
    skip_without_ffmpeg()
    from app.main import app

    add_done_job(cfg.JOBS_DIR)
    noise = shaped_noise(BALANCED, seconds=SONG_SEC)
    sf.write(str(cfg.JOBS_DIR / TAKE_JOB / "stems" / "drums.wav"), noise, SR, subtype="PCM_16")
    client = TestClient(app)
    query = f"stems=drums,{_song_long_take(client)}&gains=1.0,{HOT_TAKE_GAIN}"
    r = client.get(f"/api/jobs/{TAKE_JOB}/suggest/master?{query}")
    plan = client.get(f"/api/jobs/{TAKE_JOB}/mixdown/loudness?{query}&master={STREAMING}")
    assert r.status_code == plan.status_code == 200, (r.text, plan.text)
    [why] = [x for x in r.json()["reasons"] if x["key"].startswith(MASTER_WHY)]
    pre = plan.json()["pre"]
    assert why["vars"]["i"] == pytest.approx(pre["i"], abs=PARITY_DB)
    assert why["vars"]["tp"] == pytest.approx(pre["tp"], abs=PARITY_DB)
    assert why["vars"]["tp"] < 0, "the take limiter holds the hot take under full scale"
