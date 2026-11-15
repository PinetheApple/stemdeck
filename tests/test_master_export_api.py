"""The master in the exports: master= on mixdown.{ext} and video.mp4, and
GET mixdown/loudness.

- Malformed master values are a 422 with the contract's message before any
  measurement or render, on every route that takes one.
- The loudness route answers the plan the export renders, from the plan
  cache the second time; a client that leaves gets its measurement stopped.
- A mastered export carries the measurement as X-StemDeck-* headers, is
  keyed by its chain in the render cache, and a region gets the whole song's
  gain. mp3, ogg and the aac in video.mp4 cap the ceiling at the lossy limit.
- The stems zip, single stems and the bundle never take a master.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import subprocess
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf
from fastapi import HTTPException

from app.api import export_fx, mixdown_loudness
from app.api import stems as stems_mod
from app.core.config import (
    EXPORT_LIMIT_LOSSY_DBTP,
    MASTER_CEILING_RETRIES,
    MASTER_CORRECTION_TOL_LU,
    MASTER_PARAM_MAX_CHARS,
    ffmpeg_executable,
)
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import master_plan_cache
from app.pipeline.mastering import (
    MASTER_REQUIRED,
    MASTER_TARGET_CEILING_REQUIRED,
    MasterSettings,
    encode_master_param,
    limiter_filter,
)
from tests.ffmpeg_probe import skip_without_ffmpeg

JOB = "abcdef0f0f02"
SR = 44100
STREAMING = encode_master_param(MasterSettings(-14.0, -1.0))
Q = "stems=vocals,bass&gains=1,1"
MASTER_HEADERS = {
    "x-stemdeck-loudness-pre",
    "x-stemdeck-loudness-post",
    "x-stemdeck-master-gain",
    "x-stemdeck-target-reached",
}


def raw_param(body) -> str:
    text = body if isinstance(body, str) else json.dumps(body)
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    _jobs.clear()
    monkeypatch.setattr(master_plan_cache, "MASTER_PLAN_CACHE_DIR", tmp_path / "_cache" / "master")
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
def no_ffmpeg(monkeypatch):
    """Fails the test if anything would measure or render."""

    async def refuse(*args, **kwargs):
        raise AssertionError("ffmpeg ran")

    monkeypatch.setattr(export_fx, "cached_plan", refuse)
    monkeypatch.setattr(stems_mod, "_render_to_file", refuse)
    monkeypatch.setattr(stems_mod, "_stream_ffmpeg", refuse)


def _job(jobs_dir, seconds: float = 4.0) -> Path:
    """A melody and noise, summing to about -17 LUFS, plus a video placeholder."""
    n = int(SR * seconds)
    job = Job(id=JOB, status="done", title="Master", duration_sec=seconds)
    _jobs[job.id] = job
    stems = jobs_dir / JOB / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    t = np.arange(n) / SR
    lanes = {
        "vocals": 0.2 * np.sin(2 * np.pi * 440 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.5 * t)),
        "bass": 0.05 * np.random.default_rng(1).standard_normal(n),
    }
    for name, x in lanes.items():
        sf.write(stems / f"{name}.wav", np.stack([x, x], 1), SR, subtype="PCM_16")
    (jobs_dir / JOB / "video.mp4").write_bytes(b"not decoded")
    return stems


BAD = [
    ("%%%", "master: malformed"),
    ("a" * (MASTER_PARAM_MAX_CHARS + 1), None),
    (raw_param({"v": 1, "target": -14, "ceiling": -1, "x": "; rm -rf /"}), "master: malformed"),
    (raw_param({"v": 1, "target": "volume=10", "ceiling": -1}), "master: malformed"),
    (raw_param('{"v": 1, "target": NaN, "ceiling": -1}'), "master: malformed"),
    (raw_param({"v": 1, "target": -14, "ceiling": 3}), "master: ceiling out of range"),
    (raw_param({"v": 1, "target": -14, "ceiling": -1, "comp": 9}), "master: comp out of range"),
    (raw_param({"v": 9, "target": -14, "ceiling": -1}), "master: unsupported version"),
    (raw_param({"v": 1, "ceiling": -1}), MASTER_TARGET_CEILING_REQUIRED),
]


@pytest.mark.parametrize(("value", "detail"), BAD)
async def test_a_malformed_master_is_a_422_on_every_route(
    jobs_dir, client, no_ffmpeg, value, detail
):
    _job(jobs_dir, seconds=0.5)
    async with client as c:
        for route in ("mixdown.wav", "video.mp4", "mixdown/loudness"):
            r = await c.get(f"/api/jobs/{JOB}/{route}?{Q}&master={value}")
            assert r.status_code == 422, (route, r.text)
            assert "Traceback" not in r.text and "rm -rf" not in r.text
            if detail is not None:
                assert r.json()["detail"] == detail, (route, r.text)


async def test_the_loudness_route_needs_a_job_and_a_master(jobs_dir, client, no_ffmpeg):
    _job(jobs_dir, seconds=0.5)
    route = "mixdown/loudness"
    async with client as c:
        bad_id = await c.get(f"/api/jobs/NOTAJOB/{route}?{Q}&master={STREAMING}")
        unknown = await c.get(f"/api/jobs/abcdef999999/{route}?{Q}&master={STREAMING}")
        missing = await c.get(f"/api/jobs/{JOB}/{route}?{Q}")
        lane = await c.get(f"/api/jobs/{JOB}/{route}?stems=..%2Fx&gains=1&master={STREAMING}")
    assert bad_id.status_code == unknown.status_code == 404
    assert missing.status_code == 422 and missing.json()["detail"] == MASTER_REQUIRED
    assert lane.status_code == 422


async def test_the_loudness_route_answers_the_plan_the_export_renders(
    jobs_dir, client, monkeypatch
):
    skip_without_ffmpeg()
    _job(jobs_dir)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/mixdown/loudness?{Q}&master={STREAMING}")
        assert r.status_code == 200, r.text

        async def refuse(*args, **kwargs):
            raise AssertionError("measured twice")

        monkeypatch.setattr(master_plan_cache, "run_plan", refuse)
        again = await c.get(f"/api/jobs/{JOB}/mixdown/loudness?{Q}&master={STREAMING}")
        wav = await c.get(f"/api/jobs/{JOB}/mixdown.wav?{Q}&master={STREAMING}")
    plan = r.json()
    assert again.json() == plan
    assert plan["target"] == -14.0 and plan["ceiling"] == -1.0 and plan["reached"] is True
    assert plan["post"]["i"] == pytest.approx(-14.0, abs=0.1)
    assert plan["post"]["tp"] <= -1.0
    assert wav.status_code == 200
    assert set(wav.headers) >= MASTER_HEADERS
    assert wav.headers["x-stemdeck-master-gain"] == f"{plan['gain_db']:.2f}"
    assert wav.headers["x-stemdeck-target-reached"] == "1"
    assert wav.headers["x-stemdeck-loudness-pre"] == (
        f"i={plan['pre']['i']:.2f};tp={plan['pre']['tp']:.2f}"
    )


async def test_a_region_gets_the_whole_songs_gain(jobs_dir, client):
    skip_without_ffmpeg()
    _job(jobs_dir, seconds=6.0)
    async with client as c:
        full = await c.get(f"/api/jobs/{JOB}/mixdown.wav?{Q}&master={STREAMING}")
        region = await c.get(f"/api/jobs/{JOB}/mixdown.wav?{Q}&start=1&end=3&master={STREAMING}")
    assert full.status_code == region.status_code == 200
    assert region.headers["x-stemdeck-master-gain"] == full.headers["x-stemdeck-master-gain"]


def _fake_plan(monkeypatch, seen: list[tuple[list[Path], str, str]]):
    """A measured plan without ffmpeg: the real maths on fixed loudness."""
    from app.pipeline.mastering import Loudness, run_plan

    async def measure(inputs, graph, chain, rate):
        return Loudness(-14.0 if chain else -20.0, -2.0, 5.0)

    async def plan(stems, graph, settings, output_format, rate, measure_fn=None):
        seen.append((stems, graph, output_format))
        ceiling = master_plan_cache.effective_ceiling(settings, output_format)
        return await run_plan([], graph, settings, ceiling, rate, measure)

    async def decoded(path, rate):
        return Loudness(-14.0, -2.0, 5.0)

    monkeypatch.setattr(export_fx, "cached_plan", plan)
    monkeypatch.setattr(export_fx, "measure_file", decoded)


@pytest.fixture
def renders(monkeypatch, tmp_path) -> list[list[str]]:
    seen: list[list[str]] = []

    async def to_file(cmd, suffix, context="", cache_path=None):
        seen.append(cmd)
        cache_path = cache_path or tmp_path / f"render{len(seen)}{suffix}"
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(b"RIFF")
        return cache_path

    async def stream(cmd, context="", cache_path=None):
        seen.append(cmd)
        yield b""

    monkeypatch.setattr(stems_mod, "_render_to_file", to_file)
    monkeypatch.setattr(stems_mod, "_stream_ffmpeg", stream)
    return seen


def _graph(cmd: list[str]) -> str:
    return cmd[cmd.index("-filter_complex") + 1]


async def test_lossy_exports_cap_the_ceiling(jobs_dir, client, monkeypatch, renders):
    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])
    capped = limiter_filter(EXPORT_LIMIT_LOSSY_DBTP, SR)
    asked = limiter_filter(-1.0, SR)
    async with client as c:
        for route in ("mixdown.wav", "mixdown.flac", "mixdown.mp3", "mixdown.ogg", "video.mp4"):
            r = await c.get(f"/api/jobs/{JOB}/{route}?{Q}&master={STREAMING}")
            assert r.status_code == 200, r.text
            assert set(r.headers) >= MASTER_HEADERS, route
        lossy = await c.get(f"/api/jobs/{JOB}/mixdown/loudness?{Q}&master={STREAMING}&lossy=1")
    wav, flac, mp3, ogg, video = (_graph(cmd) for cmd in renders)
    assert asked in wav and asked in flac
    for graph in (mp3, ogg, video):
        assert capped in graph and asked not in graph
    assert lossy.json()["ceiling"] == EXPORT_LIMIT_LOSSY_DBTP


async def test_the_master_chain_runs_after_the_sum_and_is_in_the_cache_key(
    jobs_dir, client, monkeypatch, renders
):
    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])
    louder = encode_master_param(MasterSettings(-10.0, -1.0))
    async with client as c:
        for master in ("", STREAMING, STREAMING, louder):
            r = await c.get(f"/api/jobs/{JOB}/mixdown.wav?{Q}&master={master}")
            assert r.status_code == 200
    assert len(renders) == 3
    mix = _graph(renders[1]).split(";")[-1]
    assert mix.startswith("[a0][a1]amix=inputs=2:normalize=0,volume=")
    assert mix.index("volume") < mix.index("alimiter") and mix.endswith("[mix]")


async def test_the_click_is_left_out_of_the_measurement(jobs_dir, client, monkeypatch, renders):
    stems = _job(jobs_dir, seconds=0.5)
    seen: list[tuple[list[Path], str, str]] = []
    _fake_plan(monkeypatch, seen)
    click = stems_mod._ClickLane(stems.parent / "video.mp4", 0.5, 0.0, False)
    monkeypatch.setattr(stems_mod, "_click_lane", lambda *a, **k: click)
    async with client as c:
        for route in ("mixdown.wav", "video.mp4"):
            r = await c.get(f"/api/jobs/{JOB}/{route}?{Q}&click=1&master={STREAMING}")
            assert r.status_code == 200, r.text
    for measured, graph, _format in seen:
        assert [p.name for p in measured] == ["vocals.wav", "bass.wav"]
        assert "[2:a]" not in graph
    for cmd in renders:
        assert _graph(cmd).split(";")[-1].startswith("[a0][a1][a2]amix=inputs=3:normalize=0,")


async def test_a_measurement_whose_client_left_is_stopped(jobs_dir, monkeypatch):
    _job(jobs_dir, seconds=0.5)
    state = {"cancelled": False}

    async def slow_plan(*args, **kwargs):
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            state["cancelled"] = True
            raise

    class GoneRequest:
        async def is_disconnected(self):
            return True

    monkeypatch.setattr(mixdown_loudness, "prepare_export", slow_plan)
    monkeypatch.setattr(mixdown_loudness, "MASTER_LOUDNESS_POLL_SEC", 0.01)
    with pytest.raises(HTTPException) as err:
        await mixdown_loudness.get_mixdown_loudness(
            GoneRequest(),
            JOB,
            stems="vocals,bass",
            gains="1,1",
            pitches="",
            fx="",
            master=STREAMING,
            lossy=False,
        )
    assert err.value.status_code == 499
    assert state["cancelled"] is True


async def test_a_failed_measurement_is_a_500(jobs_dir, client, monkeypatch):
    from app.pipeline.mastering import MeasureError

    _job(jobs_dir, seconds=0.5)

    async def broken(*args, **kwargs):
        raise MeasureError("ffmpeg exit 1")

    monkeypatch.setattr(export_fx, "cached_plan", broken)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/mixdown.wav?{Q}&master={STREAMING}")
    assert r.status_code == 500
    assert r.json()["detail"] == "mastering measurement failed"


async def test_stems_and_bundles_never_take_a_master(jobs_dir, client, monkeypatch):
    skip_without_ffmpeg()
    _job(jobs_dir, seconds=0.5)

    async def refuse(*args, **kwargs):
        raise AssertionError("measured a master")

    monkeypatch.setattr(export_fx, "cached_plan", refuse)
    urls = [
        f"/api/jobs/{JOB}/stems/all.zip?stems=vocals,bass",
        f"/api/jobs/{JOB}/stems/vocals.wav",
        f"/api/jobs/{JOB}/stems/vocals.wav?start=0&end=0.25",
        f"/api/jobs/{JOB}/bundle.zip?stems=vocals,bass",
    ]
    async with client as c:
        for url in urls:
            plain = await c.get(url)
            sep = "&" if "?" in url else "?"
            mastered = await c.get(f"{url}{sep}master={STREAMING}")
            assert plain.status_code == mastered.status_code == 200, (url, mastered.text)
            assert not MASTER_HEADERS & set(mastered.headers), url
            if ".zip" not in url:
                assert mastered.content == plain.content, url


BURST_STEMS = "stems=vocals,bass,drums"
HOT_GAINS = "gains=0.15,0.15,0.15"
NORMAL_GAINS = "gains=1,1,1"
LOUDER = encode_master_param(MasterSettings(-9.0, -1.0))
BURST_EVERY_SEC = 0.5
BURST_SEC = 0.05
BURST_SECONDS = 4.0
LUFS_READ_SLACK = 0.1


def _burst_job(jobs_dir: Path) -> None:
    """Tone, low sine and noise bursts: mastered to -9 LUFS they overshoot in-graph."""
    _job(jobs_dir, BURST_SECONDS)
    t = np.arange(int(SR * BURST_SECONDS)) / SR
    rng = np.random.default_rng(7)
    lanes = {
        "vocals": 0.15 * np.sin(2 * np.pi * 330 * t) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.25 * t)),
        "bass": 0.2 * np.sin(2 * np.pi * 55 * t),
        "drums": 0.3 * rng.standard_normal(t.size) * (np.mod(t, BURST_EVERY_SEC) < BURST_SEC),
    }
    for name, x in lanes.items():
        sf.write(
            jobs_dir / JOB / "stems" / f"{name}.wav", np.stack([x, x], 1), SR, subtype="PCM_16"
        )
    _real_video(jobs_dir, BURST_SECONDS)


LIMIT_RE = re.compile(r"alimiter=limit=([\d.]+)")
LUFS_RE = re.compile(r"I:\s+(-?[\d.]+) LUFS")
PEAK_RE = re.compile(r"Peak:\s+(-?[\d.]+|-inf) dBFS")


def _summary(path: Path) -> tuple[float, float]:
    """Decoded loudness and true peak, by ffmpeg itself rather than the code under test."""
    err = subprocess.run(
        [ffmpeg_executable(), "-nostdin", "-hide_banner", "-i", str(path)]
        + ["-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    ).stderr
    summary = err[err.rfind("Summary:") :]
    return float(LUFS_RE.findall(summary)[-1]), float(PEAK_RE.findall(summary)[-1])


def _real_video(jobs_dir: Path, seconds: float) -> None:
    subprocess.run(
        [ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-y"]
        + ["-f", "lavfi", "-i", f"color=c=black:s=64x64:d={seconds}:r=10"]
        + ["-c:v", "mpeg4", "-an", str(jobs_dir / JOB / "video.mp4")],
        check=True,
        timeout=60,
    )


HOT_ROUTES = [
    ("mixdown.wav", -1.0),
    ("mixdown.mp3", EXPORT_LIMIT_LOSSY_DBTP),
    ("mixdown.ogg", EXPORT_LIMIT_LOSSY_DBTP),
    ("video.mp4", EXPORT_LIMIT_LOSSY_DBTP),
]


async def _decoded_export(client, tmp_path: Path, route: str, query: str):
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/{route}?{query}")
    assert r.status_code == 200, r.text
    out = tmp_path / route
    out.write_bytes(r.content)
    return r, _summary(out)


@pytest.mark.parametrize(("route", "cap"), HOT_ROUTES)
async def test_a_hot_master_holds_its_ceiling(jobs_dir, client, tmp_path, route, cap):
    """+14 dB into a -9 LUFS master: decoded, under the ceiling or the lossy cap."""
    skip_without_ffmpeg()
    _burst_job(jobs_dir)
    query = f"{BURST_STEMS}&{HOT_GAINS}&master={LOUDER}"
    r, (_lufs, peak) = await _decoded_export(client, tmp_path, route, query)
    assert float(r.headers["x-stemdeck-master-gain"]) >= 14.0
    assert peak <= cap
    assert float(r.headers["x-stemdeck-loudness-post"].split("tp=")[1]) <= cap


@pytest.mark.parametrize(("route", "cap"), HOT_ROUTES)
async def test_a_normal_master_holds_its_ceiling_and_its_loudness(
    jobs_dir, client, tmp_path, route, cap
):
    skip_without_ffmpeg()
    _burst_job(jobs_dir)
    query = f"{BURST_STEMS}&{NORMAL_GAINS}&master={STREAMING}"
    r, (lufs, peak) = await _decoded_export(client, tmp_path, route, query)
    assert peak <= cap
    assert abs(lufs - -14.0) <= MASTER_CORRECTION_TOL_LU + LUFS_READ_SLACK
    assert r.headers["x-stemdeck-target-reached"] == "1"


async def test_a_lossy_export_still_over_its_cap_reports_target_not_reached(
    jobs_dir, client, monkeypatch, renders
):
    from app.pipeline.mastering import Loudness

    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])

    async def always_over(path, rate):
        return Loudness(-14.0, -0.5)

    monkeypatch.setattr(export_fx, "measure_file", always_over)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/mixdown.mp3?{Q}&master={STREAMING}")
    assert r.status_code == 200
    assert r.headers["x-stemdeck-target-reached"] == "0"
    assert r.headers["x-stemdeck-loudness-post"] == "i=-14.00;tp=-0.50"
    # Each retry lowers the limit, then one last render adds a trim after it.
    assert len(renders) == 2 + MASTER_CEILING_RETRIES
    tails = [_graph(cmd).split(";")[-1] for cmd in renders]
    limits = [float(LIMIT_RE.search(t).group(1)) for t in tails]
    assert (
        limits[: 1 + MASTER_CEILING_RETRIES]
        == sorted(limits, reverse=True)[: 1 + MASTER_CEILING_RETRIES]
    )
    assert len(set(limits[: 1 + MASTER_CEILING_RETRIES])) == 1 + MASTER_CEILING_RETRIES
    assert all(f"aresample={SR}[mix]" in t for t in tails[:-1])
    assert ",volume=" in tails[-1].split(f"aresample={SR}")[-1]


async def test_the_limiter_runs_at_the_export_rate(jobs_dir, client, monkeypatch, renders):
    _job(jobs_dir, seconds=0.5)
    _fake_plan(monkeypatch, [])
    monkeypatch.setattr(stems_mod, "get_export_sample_rate", lambda: 48000)
    monkeypatch.setattr(export_fx, "get_export_sample_rate", lambda: 48000)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/mixdown.wav?{Q}&master={STREAMING}")
    assert r.status_code == 200
    assert limiter_filter(-1.0, 48000) in _graph(renders[0])
