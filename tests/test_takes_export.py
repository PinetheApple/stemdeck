"""Recorded takes in the exports: mixdown lanes, the limiter, the cache key and
the stems zip, through the app's own router."""

from __future__ import annotations

import io
import subprocess
import zipfile

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

import app.core.config as cfg
from app.api import stems as stems_mod
from app.api.takes_lanes import EXPORT_CEILING
from app.core.config import ffmpeg_executable
from app.core.registry import _jobs
from app.core.takes_config import MS_PER_SEC, TAKE_RATE
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
# The cache key of a drums-only mixdown at unity: a stems-only mix keeps it.
STEMS_ONLY_KEY = "bbcdb3a356beb6e913124d4bfcaf73c8397c7f5d"
# One 16-bit step of headroom for the encoder's rounding.
PCM16_STEP = 1 / 32768
IMPULSE = CAPTURE_RATE // 4
TONE_HZ = 220
TONE_AMPLITUDE = 0.6
NUDGE_MS = 100.0
SEMITONES = 3
REGION_START_SEC = 0.5
REGION_END_SEC = 1.5
VIDEO_ARGS = ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=10", "-t", "1", "-c:v", "mpeg4"]


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


@pytest.fixture
def streamed(monkeypatch):
    """Every ffmpeg command a video export streams, in order."""
    seen: list[list[str]] = []
    stream = stems_mod._stream_ffmpeg

    def spy(cmd, *args, **kwargs):
        seen.append(list(cmd))
        return stream(cmd, *args, **kwargs)

    monkeypatch.setattr(stems_mod, "_stream_ffmpeg", spy)
    return seen


def _query(stems: str, gains: str, **extra) -> str:
    return "&".join(f"{k}={v}" for k, v in {"stems": stems, "gains": gains, **extra}.items())


def _mix(client, stems: str, gains: str, **extra):
    return client.get(f"{BASE}/mixdown.wav?{_query(stems, gains, **extra)}")


def _graph(cmd: list[str]) -> str:
    return cmd[cmd.index("-filter_complex") + 1]


def _impulse_sample(placement_sec: float) -> int:
    return round(placement_sec * TAKE_RATE) + IMPULSE * TAKE_RATE // CAPTURE_RATE


def _samples(response) -> np.ndarray:
    data, rate = sf.read(io.BytesIO(response.content), dtype="float32", always_2d=True)
    assert rate == TAKE_RATE
    return data[:, 0]


def _tone_stem(name: str) -> None:
    t = np.arange(TAKE_RATE * SONG_SEC) / TAKE_RATE
    tone = (TONE_AMPLITUDE * np.sin(2 * np.pi * TONE_HZ * t)).astype(np.float32)
    path = cfg.JOBS_DIR / JOB / "stems" / f"{name}.wav"
    sf.write(str(path), np.stack([tone, tone], axis=1), TAKE_RATE, subtype="PCM_16")


def _add_video() -> None:
    out = cfg.JOBS_DIR / JOB / "video.mp4"
    subprocess.run(
        [ffmpeg_executable(), "-nostdin", "-loglevel", "error", *VIDEO_ARGS, str(out)],
        check=True,
    )


def test_a_stems_only_mix_keeps_its_graph_and_cache_key(client, commands):
    r = _mix(client, "drums", "1.0")
    assert r.status_code == 200
    assert (stems_mod._MIXDOWN_CACHE_DIR / f"{STEMS_ONLY_KEY}.wav").is_file()
    assert "alimiter" not in _graph(commands[0])


def test_a_take_in_the_mix_is_audible_where_it_was_placed_and_limited(client, track):
    entry = recorded_take(client, track, impulse=IMPULSE, frame0=1.0, round_trip_ms=20.0)
    r = _mix(client, f"drums,{track}", "1.0,1.0")
    assert r.status_code == 200
    out = _samples(r)
    assert int(np.argmax(np.abs(out))) == _impulse_sample(entry["placement_sec"])
    assert 0.5 < float(np.max(np.abs(out))) <= EXPORT_CEILING + PCM16_STEP


def test_a_take_alone_is_limited_on_its_own_chain(client, track, commands):
    recorded_take(client, track, impulse=IMPULSE)
    out = _samples(_mix(client, track, "1.0"))
    assert "[a0]alimiter=" in _graph(commands[0])
    assert 0.5 < float(np.max(np.abs(out))) <= EXPORT_CEILING + PCM16_STEP


def test_a_region_export_cuts_the_take_with_the_song(client, track):
    entry = recorded_take(client, track, impulse=IMPULSE)
    r = _mix(client, f"drums,{track}", "1.0,1.0", start=REGION_START_SEC, end=REGION_END_SEC)
    out = _samples(r)
    assert len(out) == round((REGION_END_SEC - REGION_START_SEC) * TAKE_RATE)
    expected = _impulse_sample(entry["placement_sec"]) - round(REGION_START_SEC * TAKE_RATE)
    assert int(np.argmax(np.abs(out))) == expected


def test_summed_lanes_over_the_ceiling_are_held_at_it(client, track):
    _tone_stem("drums")
    take_id = new_take(client, track)
    loud = np.full(CAPTURE_RATE, TONE_AMPLITUDE, dtype=np.float32).tobytes()
    put_part(client, take_id, 0, loud)
    assert client.post(f"{BASE}/takes/{take_id}/finish", json={}).status_code == 200
    out = _samples(_mix(client, f"drums,{take_id}", "1.0,1.0"))
    assert float(np.max(np.abs(out))) <= EXPORT_CEILING + PCM16_STEP


def test_a_shift_sent_for_a_take_lane_needs_no_transposer(client, track, monkeypatch):
    monkeypatch.setattr(stems_mod, "_rubberband_available", lambda: False)
    recorded_take(client, track)
    r = _mix(client, f"drums,{track}", "1.0,1.0", pitches=f"0,{SEMITONES}")
    assert r.status_code == 200


def test_a_key_shift_moves_the_stems_and_leaves_the_take_as_recorded(client, track, commands):
    if not stems_mod._rubberband_available():
        pytest.skip("this ffmpeg build cannot transpose")
    _tone_stem("bass")
    entry = recorded_take(client, track, impulse=IMPULSE)
    pitches = f"{SEMITONES},{SEMITONES}"
    out = _samples(_mix(client, f"bass,{track}", "0.5,1.0", pitches=pitches))
    stem_chain, take_chain = _graph(commands[0]).split(";")[:2]
    assert "rubberband" in stem_chain and "rubberband" not in take_chain
    assert int(np.argmax(np.abs(out))) == _impulse_sample(entry["placement_sec"])


def test_a_re_placed_take_misses_the_cache(client, track):
    entry = recorded_take(client, track, impulse=IMPULSE)
    first = _samples(_mix(client, track, "1.0"))
    r = client.patch(f"{BASE}/takes/{entry['id']}", json={"user_nudge_ms": NUDGE_MS})
    assert r.status_code == 200
    second = _samples(_mix(client, track, "1.0"))
    moved = round(NUDGE_MS / MS_PER_SEC * TAKE_RATE)
    assert int(np.argmax(np.abs(first))) - int(np.argmax(np.abs(second))) == moved


def test_switching_or_deleting_the_active_take_misses_the_cache(client, track):
    early = recorded_take(client, track, impulse=IMPULSE, frame0=0.5)
    late = recorded_take(client, track, impulse=IMPULSE, frame0=1.5)

    def peak_at() -> int:
        return int(np.argmax(np.abs(_samples(_mix(client, track, "1.0")))))

    assert peak_at() == _impulse_sample(late["placement_sec"])
    r = client.patch(f"{BASE}/tracks/{track}", json={"active_take_id": early["id"]})
    assert r.status_code == 200
    assert peak_at() == _impulse_sample(early["placement_sec"])
    assert client.delete(f"{BASE}/takes/{early['id']}").status_code == 200
    assert peak_at() == _impulse_sample(late["placement_sec"])


def test_video_gets_the_limiter_only_with_a_take(client, track, streamed):
    _add_video()
    recorded_take(client, track)
    assert client.get(f"{BASE}/video.mp4?{_query('drums', '1.0')}").status_code == 200
    assert client.get(f"{BASE}/video.mp4?{_query(f'drums,{track}', '1.0,1.0')}").status_code == 200
    assert "alimiter" not in _graph(streamed[0])
    assert "alimiter" in _graph(streamed[1])


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
    r = client.patch(f"{BASE}/takes/{entry['id']}", json={"label": "Verse 1"})
    assert r.status_code == 200
    named = _zip_names(client.get(f"{BASE}/stems/all.zip?stems=drums,{entry['id']}"))
    assert named == ["Song_Verse_1_" + entry["id"] + ".wav", "Song_drums.wav"]
    by_track = _zip_names(client.get(f"{BASE}/stems/all.zip?stems={track}"))
    assert by_track == ["Song_Verse_1_" + entry["id"] + ".wav"]
    assert all(entry["id"] not in n for n in _zip_names(client.get(f"{BASE}/stems/all.zip")))


def test_a_track_and_its_active_take_make_one_zip_member(client, track):
    entry = recorded_take(client, track)
    names = _zip_names(client.get(f"{BASE}/stems/all.zip?stems={track},{entry['id']}"))
    assert names == ["Song_Take_1_" + entry["id"] + ".wav"]
