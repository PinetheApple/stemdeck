"""The studio EQ in the exports: GET mixdown.{ext} and video.mp4 with fx=.

- A lane's EQ shapes the rendered file by the response fx_filters computes
  (the live engine's coefficients), measured on the export.
- An EQ that changes nothing renders the same bytes as no EQ at all.
- Malformed fx is a 422 with a safe message before any ffmpeg runs; a valid
  one is part of the render cache key.
- Graph order: lane EQ before the pitch shift, master EQ after the sum; the
  click carries no EQ; each piece of a rebuilt "original" gets its EQ.
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf
from scipy.signal import csd, welch

from app.api import stems as stems_mod
from app.core.config import FX_PARAM_MAX_CHARS, STEM_NAMES
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import fx_filters
from app.pipeline.fx_filters import Band, Eq, eq_response_db
from tests.ffmpeg_probe import skip_without_ffmpeg

JOB = "abcdef0e0e01"
SR = 44100
NOISE_LEVEL = 0.02
Q = "stems=vocals,bass&gains=1,0.8"


def fx(lanes: dict | None = None, master: list | None = None, version: int = 1) -> str:
    body: dict = {"v": version, "lanes": lanes or {}}
    if master is not None:
        body["master"] = master
    return base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")


def bell(f, g, q=1.0):
    return {"id": "eq", "out": 0, "b": [["bell", f, g, q, 12]]}


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def jobs_dir() -> Path:
    from app.core import config

    return config.JOBS_DIR


@pytest.fixture
def client(jobs_dir):
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


@pytest.fixture
def graphs(monkeypatch) -> list[str]:
    """Captures each render's filter graph instead of running ffmpeg."""
    seen: list[str] = []

    def keep(cmd):
        seen.append(cmd[cmd.index("-filter_complex") + 1])

    async def to_file(cmd, suffix, context="", cache_path=None):
        keep(cmd)
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(b"RIFF")
        return cache_path

    async def stream(cmd, context="", cache_path=None):
        keep(cmd)
        yield b""

    monkeypatch.setattr(stems_mod, "_render_to_file", to_file)
    monkeypatch.setattr(stems_mod, "_stream_ffmpeg", stream)
    return seen


def _job(jobs_dir, seconds: float = 4.0, names=("vocals", "bass")) -> Path:
    """Quiet noise lanes, a different seed each, plus a video placeholder."""
    n = int(SR * seconds)
    job = Job(id=JOB, status="done", title="Noise", duration_sec=seconds)
    _jobs[job.id] = job
    stems = jobs_dir / JOB / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(names):
        x = NOISE_LEVEL * np.random.default_rng(i + 1).standard_normal((n, 2))
        sf.write(stems / f"{name}.wav", x, SR, subtype="PCM_16")
    (jobs_dir / JOB / "video.mp4").write_bytes(b"not decoded")
    return stems


def _lane(stems: Path, name: str) -> np.ndarray:
    return sf.read(stems / f"{name}.wav", dtype="float64")[0][:, 0]


def _gain_db(x: np.ndarray, y: np.ndarray, freqs) -> np.ndarray:
    f, pxy = csd(x, y, fs=SR, nperseg=4410, noverlap=2205)
    _, pxx = welch(x, fs=SR, nperseg=4410, noverlap=2205)
    return np.interp(freqs, f, 20 * np.log10(np.abs(pxy / pxx)))


async def _wav(c, query: str) -> bytes:
    r = await c.get(f"/api/jobs/{JOB}/mixdown.wav?{query}")
    assert r.status_code == 200, r.text
    return r.content


async def test_a_lane_eq_shapes_the_export_like_the_live_engine(jobs_dir, client):
    skip_without_ffmpeg()
    stems = _job(jobs_dir)
    eq = {"id": "eq", "out": -1.5, "b": [["bell", 1000, 9, 1.4, 12], ["lowcut", 150, 0, 0.707, 24]]}
    async with client as c:
        out = await _wav(c, f"stems=vocals&gains=1&fx={fx({'vocals': [eq]})}")
    y = sf.read(io.BytesIO(out), dtype="float64")[0][:, 0]
    freqs = [60, 100, 200, 500, 1000, 2000, 5000, 10000]
    measured = _gain_db(_lane(stems, "vocals"), y, freqs)
    bands = (Band("bell", 1000, 9, 1.4, 12), Band("lowcut", 150, 0, 0.707, 24))
    expected = eq_response_db(Eq(-1.5, bands), [float(f) for f in freqs], SR)
    # 16-bit export, 10 Hz bins: 0.3 dB, and 1 dB deep in the cut's stopband.
    for f, m, e in zip(freqs, measured, expected, strict=True):
        assert abs(m - e) < (1.0 if e < -20 else 0.3), (f, m, e)


async def test_an_eq_that_changes_nothing_renders_the_same_bytes(jobs_dir, client):
    skip_without_ffmpeg()
    _job(jobs_dir)
    flat = {"id": "eq", "out": 0, "b": [["bell", 1000, 0, 1, 12], ["tilt", 800, 0, 1, 12]]}
    async with client as c:
        plain = await _wav(c, Q)
        assert await _wav(c, f"{Q}&fx={fx({'vocals': [flat]})}") == plain
        assert await _wav(c, f"{Q}&fx={fx({'other': [bell(1000, 6)]})}") == plain
        assert await _wav(c, f"{Q}&fx={fx({}, [])}") == plain
        boosted = await _wav(c, f"{Q}&fx={fx({'bass': [bell(1000, 6)]})}")
    assert boosted != plain


async def test_the_master_eq_shapes_the_whole_mix(jobs_dir, client):
    skip_without_ffmpeg()
    stems = _job(jobs_dir)
    async with client as c:
        out = await _wav(c, f"stems=vocals,bass&gains=1,1&fx={fx({}, [bell(2000, -12, 2)])}")
    y = sf.read(io.BytesIO(out), dtype="float64")[0][:, 0]
    x = _lane(stems, "vocals") + _lane(stems, "bass")
    measured = _gain_db(x, y, [2000, 200])
    assert measured[0] == pytest.approx(-12, abs=0.3)
    assert measured[1] == pytest.approx(0, abs=0.3)


async def test_the_eq_is_in_the_render_cache_key(jobs_dir, client, graphs):
    _job(jobs_dir, seconds=0.5)
    cache = stems_mod._MIXDOWN_CACHE_DIR
    async with client as c:
        await _wav(c, Q)
        await _wav(c, f"{Q}&fx={fx({'vocals': [bell(1000, 6)]})}")
        await _wav(c, f"{Q}&fx={fx({'vocals': [bell(1000, 6)]})}")
        await _wav(c, f"{Q}&fx={fx({'vocals': [bell(1000, 7)]})}")
    assert len(graphs) == 3
    assert len(list(cache.glob("*.wav"))) == 3


MALFORMED = [
    ("!!!", "fx: malformed"),
    ("A" * (FX_PARAM_MAX_CHARS + 1), None),
    (fx({"vocals": [{"id": "eq", "out": 0, "b": [["bell;rm -rf /", 1000, 1, 1, 12]]}]}), None),
    (fx({"vocals": [{"id": "eq", "out": 0, "b": [["bell", 99999, 1, 1, 12]]}]}), "frequency"),
    (fx({"../../x": [bell(1000, 3)]}), "fx: unknown lane"),
    (fx({"vocals": [{"id": "compressor"}]}), "fx: malformed"),
    (fx({"vocals": [bell(1000, 3)]}, version=2), "fx: unsupported version"),
]


@pytest.mark.parametrize(("value", "detail"), MALFORMED)
async def test_malformed_fx_is_a_422_before_any_render(jobs_dir, client, graphs, value, detail):
    _job(jobs_dir, seconds=0.5)
    async with client as c:
        for route in ("mixdown.wav", "video.mp4", "mixdown/loudness"):
            r = await c.get(f"/api/jobs/{JOB}/{route}?{Q}&fx={value}&master=")
            assert r.status_code == 422, (route, r.text)
            assert "Traceback" not in r.text and "rm -rf" not in r.text
            if detail is not None:
                assert detail in r.json()["detail"], (route, r.text)
    assert graphs == []


async def test_too_many_eq_sections_is_a_422(jobs_dir, client, graphs, monkeypatch):
    _job(jobs_dir, seconds=0.5)
    steep = {"id": "eq", "out": 0, "b": [["lowcut", 40 + i, 0, 0.707, 48] for i in range(12)]}
    query = f"stems=vocals,bass&gains=1,1&fx={fx({'vocals': [steep], 'bass': [steep]}, [steep])}"
    async with client as c:
        # 12 bands of 4 sections on two lanes and the master: 144.
        assert (await c.get(f"/api/jobs/{JOB}/mixdown.wav?{query}")).status_code == 200
        monkeypatch.setattr(fx_filters, "FX_MAX_SECTIONS", 143)
        r = await c.get(f"/api/jobs/{JOB}/mixdown.wav?{query}")
    assert r.status_code == 422
    assert r.json()["detail"] == fx_filters.FX_TOO_MANY_SECTIONS


async def test_lane_eq_runs_before_the_shift_and_master_eq_after_the_sum(
    jobs_dir, client, graphs, monkeypatch
):
    _job(jobs_dir, seconds=0.5)
    monkeypatch.setattr(stems_mod, "_rubberband_available", lambda: True)
    eqs = fx({"vocals": [bell(1000, 6)]}, [bell(3000, -3)])
    async with client as c:
        for route in ("mixdown.wav", "video.mp4"):
            url = f"/api/jobs/{JOB}/{route}?stems=vocals,bass&gains=1,1&pitches=2,0&fx={eqs}"
            assert (await c.get(url)).status_code == 200
    for graph in graphs:
        lanes = graph.split(";")
        assert lanes[0].startswith("[0:a]biquad=")
        assert lanes[0].index("biquad") < lanes[0].index("rubberband")
        assert lanes[1].startswith("[1:a]volume=")
        assert lanes[-1].index("amix") < lanes[-1].index("biquad")
        assert lanes[-1].endswith("[mix]")


async def test_a_single_lane_with_a_master_eq_maps_the_eq_output(jobs_dir, client, graphs):
    _job(jobs_dir, seconds=0.5)
    async with client as c:
        assert (await c.get(f"/api/jobs/{JOB}/mixdown.wav?stems=vocals&gains=1")).status_code == 200
        url = f"/api/jobs/{JOB}/mixdown.wav?stems=vocals&gains=1&fx={fx({}, [bell(500, 4)])}"
        assert (await c.get(url)).status_code == 200
    assert graphs[0] == "[0:a]volume=1.000000[a0]"
    assert graphs[1].startswith("[0:a]volume=1.000000[a0];[a0]biquad=")
    assert graphs[1].endswith("[mix]")


async def test_the_click_carries_no_eq_and_joins_before_the_master_eq(
    jobs_dir, client, graphs, monkeypatch
):
    stems = _job(jobs_dir, seconds=0.5)
    click = stems_mod._ClickLane(stems / "vocals.wav", 0.5, 0.0, False)
    monkeypatch.setattr(stems_mod, "_click_lane", lambda *a, **k: click)
    eqs = fx({"vocals": [bell(1000, 6)], "bass": [bell(200, 3)]}, [bell(3000, -3)])
    async with client as c:
        for route in ("mixdown.wav", "video.mp4"):
            url = f"/api/jobs/{JOB}/{route}?stems=vocals,bass&gains=1,1&click=1&fx={eqs}"
            assert (await c.get(url)).status_code == 200
    for graph in graphs:
        lanes = graph.split(";")
        assert lanes[2].startswith("[2:a]volume=0.500000") and "biquad" not in lanes[2]
        assert lanes[-1].startswith("[a0][a1][a2]amix=inputs=3:normalize=0,biquad=")


async def test_each_piece_of_a_rebuilt_original_gets_the_original_eq(
    jobs_dir, client, graphs, monkeypatch
):
    pieces = [n for n in STEM_NAMES if n != "vocals"]
    _job(jobs_dir, seconds=0.5, names=("vocals", "original", *pieces))
    monkeypatch.setattr(stems_mod, "_rubberband_available", lambda: True)
    eqs = fx({"original": [bell(800, 5)]})
    url = f"/api/jobs/{JOB}/mixdown.wav?stems=vocals,original&gains=1,1&pitches=0,2&fx={eqs}"
    async with client as c:
        assert (await c.get(url)).status_code == 200
    lanes = graphs[0].split(";")
    assert lanes[0].startswith("[0:a]volume=")
    assert len(lanes) == 2 + len(pieces)
    for i in range(1, 1 + len(pieces)):
        assert lanes[i].startswith(f"[{i}:a]biquad="), lanes[i]
