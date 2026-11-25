"""GET /api/jobs/{id}/suggest/eq.

- Validation before any ffmpeg: a bad job id, an unknown job, a traversal
  attempt, a lane the job lacks and an unfinished job are 404; an unknown
  layout, mode, lane, target, a target of another instrument and a malformed
  fx are 422.
- The happy path answers the contract's shape; a lane is measured once and
  answered from the cache for every other target and mode.
- A lane too quiet or too short is refused with 422 "not enough signal".
- Rendering a lane through its suggestion (the export's ffmpeg filters) and
  asking again gives almost nothing more to do.
"""

from __future__ import annotations

import base64
import json
import subprocess

import httpx
import numpy as np
import pytest
import soundfile as sf

from app.api import suggest as suggest_mod
from app.core.config import ffmpeg_executable
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import eq_fit as F
from app.pipeline.eq_analysis import N_BANDS
from app.pipeline.eq_suggest import NOT_ENOUGH_SIGNAL
from app.pipeline.eq_targets import get_target
from app.pipeline.fx_filters import BELL, HIGHSHELF, LOWCUT, Band, Eq, eq_filter
from tests.ffmpeg_probe import skip_without_ffmpeg
from tests.test_eq_suggest import BALANCED, shaped_noise

JOB = "abcdef0f0f03"
OTHER_JOB = "abcdef0f0f04"
SR = 44100
SECONDS = 8


def fx_param(lanes: dict) -> str:
    raw = json.dumps({"v": 1, "lanes": lanes}).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def jobs_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(suggest_mod, "SUGGEST_CACHE_DIR", tmp_path / "cache" / "suggest")
    from app.core import config

    return config.JOBS_DIR


@pytest.fixture
def client(jobs_dir):
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


@pytest.fixture
def no_ffmpeg(monkeypatch):
    async def refuse(*args, **kwargs):
        raise AssertionError("ffmpeg ran before validation")

    monkeypatch.setattr(suggest_mod, "_run_analysis", refuse)


@pytest.fixture
def count_runs(monkeypatch):
    calls = []
    real = suggest_mod._run_analysis

    async def counted(path):
        calls.append(path)
        return await real(path)

    monkeypatch.setattr(suggest_mod, "_run_analysis", counted)
    return calls


def _job(jobs_dir, lanes: dict[str, np.ndarray], job_id: str = JOB) -> None:
    job = Job(id=job_id, status="done", title="Suggest", duration_sec=float(SECONDS))
    _jobs[job.id] = job
    stems = jobs_dir / job_id / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    for name, x in lanes.items():
        sf.write(stems / f"{name}.wav", x, SR, subtype="PCM_16")
        job.stems.append({"name": name, "url": f"/api/jobs/{job_id}/stems/{name}.wav"})


def _lanes():
    other = get_target("other.balanced").bands_db
    bass = get_target("bass.balanced").bands_db
    return {
        "other": shaped_noise(other, seconds=SECONDS, extra=[Band(BELL, 250.0, 6.0, 1.0, 12)]),
        "bass": shaped_noise(
            bass, seconds=SECONDS, seed=2, extra=[Band(BELL, 400.0, 8.0, 1.0, 12)]
        ),
        "vocals": shaped_noise(
            other, seconds=SECONDS, seed=3, extra=[Band(BELL, 630.0, 6.0, 1.0, 12)]
        ),
    }


LANE_BAD = [
    "lane=other&layout=pedal",
    "lane=other&mode=sideways",
    "lane=bass&layout=bass",
    "lane=mix",
    "lane=..%2F..%2Fsecret",
    "lane=other&layout=bass",
    "lane=drums&layout=graph",
    "lane=vocals&layout=keys",
    "lane=other&target=nope.balanced",
    "lane=other&target=bass.balanced",
    "lane=other&fx=%25%25%25",
    "lane=other&fx=" + fx_param({"other": [{"id": "eq", "b": [["bell", 1e9, 0, 1, 12]]}]}),
    "lane=" + "a" * 40,
]


@pytest.mark.parametrize("query", LANE_BAD)
async def test_bad_input_is_refused_before_ffmpeg(client, jobs_dir, no_ffmpeg, query):
    _job(jobs_dir, _lanes())
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/suggest/eq?{query}")
    assert r.status_code == 422, r.text
    assert "Traceback" not in r.text and str(jobs_dir) not in r.text


@pytest.mark.parametrize(
    "url",
    [
        "/api/jobs/not-a-job/suggest/eq?lane=other",
        "/api/jobs/abcdef0f0fff/suggest/eq?lane=other",
        "/api/jobs/../../etc/passwd/suggest/eq?lane=other",
        "/api/jobs/..%2F..%2Fetc/suggest/eq?lane=other",
        f"/api/jobs/{JOB}/suggest/eq?lane=guitar&layout=graph",
    ],
)
async def test_unknown_jobs_lanes_and_traversal_are_404(client, jobs_dir, no_ffmpeg, url):
    _job(jobs_dir, _lanes())
    async with client as c:
        r = await c.get(url)
    assert r.status_code == 404


async def test_a_job_that_is_not_done_is_404(client, jobs_dir, no_ffmpeg):
    _job(jobs_dir, _lanes())
    _jobs[JOB].status = "running"
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/suggest/eq?lane=other")
    assert r.status_code == 404


async def test_lane_suggestion_shape_and_cache(client, jobs_dir, count_runs):
    skip_without_ffmpeg()
    _job(jobs_dir, _lanes())
    current = {"other": [{"id": "eq", "out": 0, "b": [["highshelf", 8000, 2, 0.707, 12]]}]}
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/suggest/eq?lane=other")
        bright = await c.get(f"/api/jobs/{JOB}/suggest/eq?lane=other&target=other.bright")
        merged = await c.get(
            f"/api/jobs/{JOB}/suggest/eq?lane=other&mode=merge&fx={fx_param(current)}"
        )
    assert r.status_code == bright.status_code == merged.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"bands", "out", "reasons", "loudness", "target", "targets", "target_curve"}
    assert len(body["target_curve"]) == N_BANDS
    assert body["target"] == "other.balanced"
    assert {t["id"] for t in body["targets"]} == {"other.balanced", "other.warm", "other.bright"}
    assert 1 <= len(body["bands"]) <= F.SUGGEST_MAX_BANDS_LANE
    assert [b for b in body["bands"] if b["type"] == BELL and 160 <= b["f"] <= 400 and b["g"] < 0]
    assert abs(body["loudness"]) < 0.15
    assert len(count_runs) == 1
    assert len(list(suggest_mod.SUGGEST_CACHE_DIR.iterdir())) == 1
    added = merged.json()["bands"]
    assert len(added) <= F.SUGGEST_MAX_BANDS_LANE
    assert not [b for b in added if (b["type"], b["f"], b["g"]) == (HIGHSHELF, 8000.0, 2.0)]


async def test_the_bass_lane_gets_the_graph_fit_and_merge(client, jobs_dir):
    skip_without_ffmpeg()
    _job(jobs_dir, _lanes())
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/suggest/eq?lane=bass&layout=graph")
        merged = await c.get(f"/api/jobs/{JOB}/suggest/eq?lane=bass&layout=graph&mode=merge")
    assert r.status_code == merged.status_code == 200, r.text
    assert r.json()["target"] == "bass.balanced"
    free = {s.id for s in F.LAYOUTS[F.FREE]}
    assert r.json()["bands"] and all(b["slot"] in free for b in r.json()["bands"])


async def test_a_vocal_lane_gets_the_parametric_eq(client, jobs_dir):
    skip_without_ffmpeg()
    _job(jobs_dir, _lanes())
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/suggest/eq?lane=vocals&layout=graph")
    assert r.status_code == 200, r.text
    assert r.json()["target"] == "other.balanced"
    free = {s.id for s in F.LAYOUTS[F.FREE]}
    assert r.json()["bands"] and all(b["slot"] in free for b in r.json()["bands"])


@pytest.mark.parametrize(
    ("gain_db", "seconds"),
    [(-48.0, SECONDS), (0.0, 2)],
    ids=["too-quiet", "too-short"],
)
async def test_not_enough_signal_is_422(client, jobs_dir, gain_db, seconds):
    skip_without_ffmpeg()
    lanes = _lanes()
    lanes["other"] = lanes["other"][: SR * seconds] * 10 ** (gain_db / 20)
    _job(jobs_dir, lanes)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/suggest/eq?lane=other")
    assert r.status_code == 422
    assert r.json()["detail"] == NOT_ENOUGH_SIGNAL


def _render(src, dst, chain):
    subprocess.run(
        [ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-y", "-i", str(src),
         "-af", chain, "-c:a", "pcm_s16le", str(dst)],
        check=True,
        timeout=120,
    )  # fmt: skip


async def test_suggesting_again_after_rendering_the_suggestion_changes_little(client, jobs_dir):
    skip_without_ffmpeg()
    mud_and_dark = [Band(BELL, 315.0, 6.0, 1.0, 12), Band(HIGHSHELF, 5000.0, -6.0, 0.707, 12)]
    _job(jobs_dir, {"original": shaped_noise(BALANCED, seconds=SECONDS, extra=mud_and_dark)})
    _job(jobs_dir, {}, job_id=OTHER_JOB)
    async with client as c:
        first = (await c.get(f"/api/jobs/{JOB}/suggest/eq?lane=original")).json()
        bands = tuple(Band(b["type"], b["f"], b["g"], b["q"], b["slope"]) for b in first["bands"])
        assert bands
        src = jobs_dir / JOB / "stems" / "original.wav"
        dst = jobs_dir / OTHER_JOB / "stems" / "original.wav"
        _render(src, dst, eq_filter(Eq(first["out"], bands), SR))
        again = await c.get(f"/api/jobs/{OTHER_JOB}/suggest/eq?lane=original")
    assert again.status_code == 200, again.text
    redo = again.json()["bands"]
    assert len(redo) <= 1
    assert all(abs(b["g"]) <= 1.5 for b in redo if b["type"] != LOWCUT)
