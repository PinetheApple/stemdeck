"""Exports without fx= or master= are byte-identical to the exports before
either existed: the same ffmpeg argv and the same render cache key, so every
cached mixdown stays valid. The argv and the keys below are literals taken
from the export code as it was before the EQ and the master were wired in.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import stems as stems_mod
from app.core.config import ffmpeg_executable
from app.core.models import Job
from app.core.registry import _jobs

JOB = "abcdef0a0a03"
RATE = 44100
KEY_TWO_LANES_WAV = "95232ef16c0e0d55f247ddfffcd1e2e0753f1eb9"
KEY_REGION_MP3 = "bf793affd86ff20b7f0873cbbd6778e7e1129bc4"
TWO_LANE_GRAPH = (
    "[0:a]volume=1.000000[a0];[1:a]volume=0.800000[a1];[a0][a1]amix=inputs=2:normalize=0[mix]"
)
FLAT_EQ = {"id": "eq", "out": 0, "b": [["bell", 1000, 0, 1, 12], ["tilt", 800, 0, 1, 12]]}


def _fx(lanes: dict) -> str:
    body = json.dumps({"v": 1, "lanes": lanes}).encode()
    return base64.urlsafe_b64encode(body).decode().rstrip("=")


NO_EFFECT_QUERIES = ["", "&fx=&master=", f"&fx={_fx({'vocals': [FLAT_EQ]})}"]


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def stems_dir(tmp_path, monkeypatch) -> Path:
    from app.core import config

    monkeypatch.setattr(stems_mod, "get_export_sample_rate", lambda: RATE)
    job = Job(id=JOB, status="done", title="Same")
    _jobs[job.id] = job
    stems = config.JOBS_DIR / JOB / "stems"
    stems.mkdir(parents=True)
    for name in ("vocals", "bass"):
        (stems / f"{name}.wav").write_bytes(b"RIFF")
    (config.JOBS_DIR / JOB / "video.mp4").write_bytes(b"not decoded")
    return stems.resolve()


@pytest.fixture
def renders(monkeypatch) -> list[tuple[list[str], Path | None]]:
    seen: list[tuple[list[str], Path | None]] = []

    async def capture_file(cmd, suffix, context="", cache_path=None):
        seen.append((cmd, cache_path))
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(b"RIFF")
        return cache_path

    async def capture_stream(cmd, context="", cache_path=None):
        seen.append((cmd, cache_path))
        yield b""

    monkeypatch.setattr(stems_mod, "_render_to_file", capture_file)
    monkeypatch.setattr(stems_mod, "_stream_ffmpeg", capture_stream)
    return seen


def _client() -> TestClient:
    from app.main import app

    return TestClient(app)


@pytest.mark.parametrize("extra", NO_EFFECT_QUERIES)
def test_two_lane_mixdown_argv_and_key_are_unchanged(stems_dir, renders, extra):
    r = _client().get(f"/api/jobs/{JOB}/mixdown.wav?stems=vocals,bass&gains=1,0.8{extra}")
    assert r.status_code == 200, r.text
    cmd, cache_path = renders[0]
    assert cmd == [
        ffmpeg_executable(),
        *("-nostdin", "-loglevel", "error"),
        *("-i", str(stems_dir / "vocals.wav"), "-i", str(stems_dir / "bass.wav")),
        "-filter_complex",
        TWO_LANE_GRAPH,
        *("-map", "[mix]", "-c:a", "pcm_s16le", "-f", "wav", "-ar", str(RATE)),
    ]
    assert cache_path.name == f"{KEY_TWO_LANES_WAV}.wav"
    assert not any(h.startswith("x-stemdeck-") for h in r.headers)


@pytest.mark.parametrize("extra", NO_EFFECT_QUERIES)
def test_single_lane_region_mixdown_argv_and_key_are_unchanged(stems_dir, renders, extra):
    query = f"stems=vocals&gains=1&start=1&end=2{extra}"
    r = _client().get(f"/api/jobs/{JOB}/mixdown.mp3?{query}")
    assert r.status_code == 200, r.text
    cmd, cache_path = renders[0]
    assert cmd == [
        ffmpeg_executable(),
        *("-nostdin", "-loglevel", "error"),
        *("-ss", "1.0", "-i", str(stems_dir / "vocals.wav")),
        *("-filter_complex", "[0:a]volume=1.000000[a0]", "-map", "[a0]", "-t", "1.0"),
        *("-q:a", "2", "-f", "mp3", "-ar", str(RATE)),
    ]
    assert cache_path.name == f"{KEY_REGION_MP3}.mp3"


@pytest.mark.parametrize("extra", NO_EFFECT_QUERIES)
def test_video_argv_is_unchanged(stems_dir, renders, extra):
    r = _client().get(f"/api/jobs/{JOB}/video.mp4?stems=vocals,bass&gains=1,0.8{extra}")
    assert r.status_code == 200, r.text
    cmd, _cache = renders[0]
    assert cmd == [
        ffmpeg_executable(),
        *("-nostdin", "-loglevel", "error"),
        *("-i", str(stems_dir / "vocals.wav"), "-i", str(stems_dir / "bass.wav")),
        *("-i", str((stems_dir.parent / "video.mp4").resolve())),
        "-filter_complex",
        TWO_LANE_GRAPH,
        *("-map", "[mix]", "-map", "2:v", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k"),
        *("-shortest", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"),
    ]
    assert not any(h.startswith("x-stemdeck-") for h in r.headers)
