"""Recorded takes in the exports: mixdown lanes, the limiter, the cache key and
the stems zip, through the app's own router."""

from __future__ import annotations

import io
import zipfile

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import stems as stems_mod
from app.api.takes_lanes import EXPORT_CEILING
from app.core.registry import _jobs
from app.core.takes_config import TAKE_RATE
from tests._takes_helpers import (
    CAPTURE_RATE,
    JOB,
    SONG_SEC,
    add_done_job,
    new_take,
    new_track,
    pcm,
    put_part,
    recorded_take,
)
from tests.ffmpeg_probe import skip_without_ffmpeg

BASE = f"/api/jobs/{JOB}"
# What _mixdown_cache_key gives for drums at unity before takes existed.
STEMS_ONLY_KEY = "bbcdb3a356beb6e913124d4bfcaf73c8397c7f5d"
# One 16-bit step of headroom for the encoder's rounding.
PCM16_STEP = 1 / 32768
IMPULSE = CAPTURE_RATE // 4
TONE_HZ = 220
TONE_AMPLITUDE = 0.6


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture(autouse=True)
def _needs_ffmpeg():
    skip_without_ffmpeg()


@pytest.fixture
def job():
    job = add_done_job(cfg.JOBS_DIR)
    job.title = "Song"
    return job


@pytest.fixture
def client(job):
    from app.main import app

    return TestClient(app)


@pytest.fixture
def track(client):
    return new_track(client)


@pytest.fixture
def commands(monkeypatch):
    """Every ffmpeg command a mixdown renders, in order."""
    seen: list[list[str]] = []
    render = stems_mod._render_to_file

    async def spy(cmd, *args, **kwargs):
        seen.append(list(cmd))
        return await render(cmd, *args, **kwargs)

    monkeypatch.setattr(stems_mod, "_render_to_file", spy)
    return seen


def _mix(client, stems: str, gains: str, **extra):
    query = "&".join(f"{k}={v}" for k, v in {"stems": stems, "gains": gains, **extra}.items())
    return client.get(f"{BASE}/mixdown.wav?{query}")


def _samples(response) -> np.ndarray:
    data, rate = sf.read(io.BytesIO(response.content), dtype="float32", always_2d=True)
    assert rate == TAKE_RATE
    return data[:, 0]


def _tone_drums() -> None:
    t = np.arange(TAKE_RATE * SONG_SEC) / TAKE_RATE
    tone = (TONE_AMPLITUDE * np.sin(2 * np.pi * TONE_HZ * t)).astype(np.float32)
    path = cfg.JOBS_DIR / JOB / "stems" / "drums.wav"
    sf.write(str(path), np.stack([tone, tone], axis=1), TAKE_RATE, subtype="PCM_16")


def test_a_stems_only_mix_keeps_its_graph_and_cache_key(client, commands):
    r = _mix(client, "drums", "1.0")
    assert r.status_code == 200
    assert (stems_mod._MIXDOWN_CACHE_DIR / f"{STEMS_ONLY_KEY}.wav").is_file()
    graph = commands[0][commands[0].index("-filter_complex") + 1]
    assert "alimiter" not in graph


def test_a_take_in_the_mix_is_audible_where_it_was_placed_and_limited(client, track):
    entry = recorded_take(client, track, impulse=IMPULSE, frame0=1.0, round_trip_ms=20.0)
    r = _mix(client, f"drums,{track}", "1.0,1.0")
    assert r.status_code == 200
    out = _samples(r)
    expected = round(entry["placement_sec"] * TAKE_RATE) + IMPULSE * TAKE_RATE // CAPTURE_RATE
    assert int(np.argmax(np.abs(out))) == expected
    assert 0.5 < float(np.max(np.abs(out))) <= EXPORT_CEILING + PCM16_STEP


def test_summed_lanes_over_the_ceiling_are_held_at_it(client, track):
    _tone_drums()
    take_id = new_take(client, track)
    loud = np.full(CAPTURE_RATE, TONE_AMPLITUDE, dtype=np.float32).tobytes()
    put_part(client, take_id, 0, loud)
    assert client.post(f"{BASE}/takes/{take_id}/finish", json={}).status_code == 200
    out = _samples(_mix(client, f"drums,{take_id}", "1.0,1.0"))
    assert float(np.max(np.abs(out))) <= EXPORT_CEILING + PCM16_STEP


def test_a_take_lane_is_never_transposed(client, track, monkeypatch):
    monkeypatch.setattr(stems_mod, "_rubberband_available", lambda: False)
    recorded_take(client, track)
    r = _mix(client, f"drums,{track}", "1.0,1.0", pitches="0,3")
    assert r.status_code == 200


def test_a_re_placed_take_misses_the_cache(client, track):
    entry = recorded_take(client, track, impulse=IMPULSE)
    first = _samples(_mix(client, track, "1.0"))
    client.patch(f"{BASE}/takes/{entry['id']}", json={"user_nudge_ms": 100.0})
    second = _samples(_mix(client, track, "1.0"))
    moved = round(0.1 * TAKE_RATE)
    assert int(np.argmax(np.abs(first))) - int(np.argmax(np.abs(second))) == moved


def test_unresolvable_take_lanes_are_422(client, track):
    open_id = new_take(client, track)
    put_part(client, open_id, 0, pcm(100))
    for lane in ("t00000000", track, open_id):
        assert _mix(client, f"drums,{lane}", "1.0,1.0").status_code == 422, lane


def _zip_names(response) -> list[str]:
    assert response.status_code == 200
    return sorted(zipfile.ZipFile(io.BytesIO(response.content)).namelist())


def test_the_zip_holds_a_take_only_when_named(client, track):
    entry = recorded_take(client, track)
    client.patch(f"{BASE}/takes/{entry['id']}", json={"label": "Verse 1"})
    named = _zip_names(client.get(f"{BASE}/stems/all.zip?stems=drums,{entry['id']}"))
    assert named == ["Song_Verse_1_" + entry["id"] + ".wav", "Song_drums.wav"]
    by_track = _zip_names(client.get(f"{BASE}/stems/all.zip?stems={track}"))
    assert by_track == ["Song_Verse_1_" + entry["id"] + ".wav"]
    assert all(entry["id"] not in n for n in _zip_names(client.get(f"{BASE}/stems/all.zip")))
