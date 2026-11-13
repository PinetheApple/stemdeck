"""Click sounds and the click file in the stems zip, through the export routes.

Ported from upstream PR 831 (sounds, the zip's click file) and upstream PR 837
(the exported click at the level the app plays it), onto this fork's routes:

- an unknown sound is a 422 everywhere a click is rendered, and the mix export
  uses the chosen sound;
- the stems zip carries `<song>_click.<ext>` only when asked, and is otherwise
  byte for byte what it was; the click file has the stems' exact length, rate
  and channels, its onsets on the grid the app clicks to (the user's beat and
  tempo edits included), and the zip's files sum to the mix export;
- every export carries the click on each channel at the live level.
"""

from __future__ import annotations

import io
import json
import subprocess
import wave
import zipfile
from pathlib import Path

import httpx
import numpy as np
import pytest
import soundfile as sf

from app.api import stems as stems_mod
from app.core import config
from app.core.config import CLICK_STEM_NAME, EXTRA_STEM_NAMES, STEM_NAMES, ffmpeg_executable
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline import click_sounds as cs
from app.pipeline.click_render import LEVEL_DOWNBEAT, beat_level, render_click_wav
from tests.ffmpeg_probe import skip_without_ffmpeg

SR = 44100
JOB = "c1c2c3c4c5c6"
STEM_SECONDS = 3.3  # deliberately not the grid's 3.0: the stems decide the length
# "tempo": null is a grid analysis found no tempo for, so these beats are the
# ones the app clicks to as they stand (a grid without the key would be fitted
# and continued to cover the song; see the GET /beats test below).
GRID = {
    "version": 1,
    "beats": [0.5, 1.0, 1.5, 2.0, 2.5, 3.0],
    "bars": [{"beat": 0, "beats_per_bar": 4}],
    "duration": 3.0,
    "tempo": None,
}
ONSET_THRESHOLD = 0.02
LIVE_LEVEL_TOLERANCE_DB = 0.05
INT16_LSB = 1 / 32767


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def jobs_dir() -> Path:
    return config.JOBS_DIR


@pytest.fixture
def client(jobs_dir):
    from app.main import app

    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


def _make_job(jobs_dir: Path, names=("vocals", "drums"), grid=True) -> Job:
    job = Job(id=JOB, status="done", title="Clicky", duration_sec=STEM_SECONDS)
    stems = jobs_dir / JOB / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(3)
    n = int(round(STEM_SECONDS * SR))
    for name in names:
        noise = (rng.standard_normal((n, 2)) * 0.05).clip(-1, 1)
        sf.write(stems / f"{name}.wav", noise, SR, subtype="PCM_16")
        job.stems.append({"name": name, "url": f"/api/jobs/{JOB}/stems/{name}.wav"})
    if grid:
        (stems / "beats.json").write_text(json.dumps(GRID), encoding="utf-8")
    _jobs[job.id] = job
    return job


def _zip(content: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(content))


def _onsets(x: np.ndarray, threshold: float = ONSET_THRESHOLD, gap: float = 0.2) -> list[int]:
    """First sample of each burst above `threshold`, bursts `gap` s apart."""
    out: list[int] = []
    for i in np.flatnonzero(np.abs(x) > threshold):
        if not out or i - out[-1] > gap * SR:
            out.append(int(i))
    return out


def _expected_onsets(beats: list[float], bars: list[dict], sound: str, gain: float) -> list[int]:
    """Where each beat's voice first crosses the threshold, from the beat's own sample."""
    out = []
    for i, t in enumerate(beats):
        voice = cs.render_voice(sound, beat_level(i, bars, -1), SR) * gain
        out.append(int(round(t * SR)) + int(np.flatnonzero(np.abs(voice) > ONSET_THRESHOLD)[0]))
    return out


def _wav(content: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(content), "rb") as w:
        n = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(float) / 32767.0
    return data.reshape(-1, n)


# ── The stems zip ──


async def test_the_zip_is_byte_for_byte_unchanged_without_the_click(client, jobs_dir):
    """Click off (or absent) builds exactly the zip it always did, whatever
    other click parameters ride along."""
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    async with client as c:
        plain = await c.get(f"/api/jobs/{JOB}/stems/all.zip")
        off = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=0&click_sound=cowbell&click_gain=2")
    assert plain.status_code == off.status_code == 200
    assert sorted(_zip(plain.content).namelist()) == ["Clicky_drums.wav", "Clicky_vocals.wav"]
    assert plain.content == off.content


@pytest.mark.parametrize("sound", ["classic", "rimshot"])
async def test_the_zip_click_is_sample_aligned_with_the_stems(client, jobs_dir, sound):
    """Same length, rate and channels as the stems, onsets on the grid's beats
    within one sample, at the click's export level."""
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    gain = 0.6
    async with client as c:
        r = await c.get(
            f"/api/jobs/{JOB}/stems/all.zip?click=1&click_gain={gain}&click_sound={sound}"
        )
    assert r.status_code == 200
    zf = _zip(r.content)
    assert sorted(zf.namelist()) == ["Clicky_click.wav", "Clicky_drums.wav", "Clicky_vocals.wav"]
    stem, stem_sr = sf.read(io.BytesIO(zf.read("Clicky_drums.wav")))
    click, click_sr = sf.read(io.BytesIO(zf.read("Clicky_click.wav")))
    assert click_sr == stem_sr == SR
    assert click.shape == stem.shape, "the click must be exactly as long as the stems"
    assert np.array_equal(click[:, 0], click[:, 1]), "a mono click, on both channels"
    expected = _expected_onsets(GRID["beats"], GRID["bars"], sound, gain)
    got = _onsets(click[:, 0])
    assert len(got) == len(expected)
    assert max(abs(g - e) for g, e in zip(got, expected, strict=True)) <= 1, (got, expected)
    peak = np.max(np.abs(click[: int(0.9 * SR), 0]))
    want = np.max(np.abs(cs.render_voice(sound, LEVEL_DOWNBEAT, SR))) * gain
    assert peak == pytest.approx(want, abs=3 * INT16_LSB)


async def test_the_zip_click_follows_rate_accent_and_edited_beats(client, jobs_dir):
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    edited = [0.25, 0.75, 1.25, 1.75]
    (jobs_dir / JOB / "stems" / "beats.user.json").write_text(
        json.dumps({"beats": edited, "bars": []}), encoding="utf-8"
    )
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1&click_mult=2&click_accent=0")
    click, _ = sf.read(io.BytesIO(_zip(r.content).read("Clicky_click.wav")))
    # x2 inserts midpoints: 0.25, 0.5, 0.75 ... 1.75 = 7 clicks, 0.25 s apart.
    got = _onsets(click[:, 0], gap=0.1)
    assert len(got) == 7
    assert abs(got[0] - 0.25 * SR) < 0.002 * SR
    assert abs(got[1] - 0.5 * SR) < 0.002 * SR


async def test_the_zip_click_follows_a_user_tempo_edit(client, jobs_dir):
    """A constant tempo the user set (100 BPM from 0.3 s) replaces the detected
    beats in the click file, as it does in playback and in the mix export."""
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    tempo = {"mode": "constant", "bpm": 100.0, "anchor": 0.3, "beats_per_bar": 4}
    (jobs_dir / JOB / "stems" / "beats.user.json").write_text(
        json.dumps({"tempo": tempo}), encoding="utf-8"
    )
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1&click_gain=0.6")
    click, _ = sf.read(io.BytesIO(_zip(r.content).read("Clicky_click.wav")))
    beats = [0.3, 0.9, 1.5, 2.1, 2.7]
    bars = [{"beat": 0, "beats_per_bar": 4}]
    expected = _expected_onsets(beats, bars, "classic", 0.6)
    got = _onsets(click[:, 0])
    assert len(got) == len(expected), (got, expected)
    assert max(abs(g - e) for g, e in zip(got, expected, strict=True)) <= 1, (got, expected)


async def test_the_zip_click_is_the_grid_the_app_clicks_to(client, jobs_dir):
    """A grid analysed before tempo existed is fitted and continued over the
    song when read; the zip clicks every beat GET /beats serves, the one
    continued before 0.5 s included."""
    skip_without_ffmpeg()
    _make_job(jobs_dir, grid=False)
    legacy = {k: v for k, v in GRID.items() if k != "tempo"}
    (jobs_dir / JOB / "stems" / "beats.json").write_text(json.dumps(legacy), encoding="utf-8")
    async with client as c:
        served = (await c.get(f"/api/jobs/{JOB}/beats")).json()
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1&click_gain=0.6")
    assert len(served["beats"]) > len(GRID["beats"]), "the served grid is the continued one"
    click, _ = sf.read(io.BytesIO(_zip(r.content).read("Clicky_click.wav")))
    expected = _expected_onsets(served["beats"], served["bars"], "classic", 0.6)
    got = _onsets(click[:, 0])
    assert len(got) == len(expected), (got, expected)
    assert max(abs(g - e) for g, e in zip(got, expected, strict=True)) <= 1, (got, expected)


@pytest.mark.parametrize("fmt", ["mp3", "flac", "ogg"])
async def test_the_zip_click_is_in_the_zips_format_and_length(client, jobs_dir, fmt):
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?format={fmt}&click=1&click_sound=woodblock")
    assert r.status_code == 200
    zf = _zip(r.content)
    assert f"Clicky_click.{fmt}" in zf.namelist()
    with zf.open(f"Clicky_drums.{fmt}") as s, zf.open(f"Clicky_click.{fmt}") as k:
        a, b = sf.info(io.BytesIO(s.read())), sf.info(io.BytesIO(k.read()))
    assert (b.samplerate, b.channels) == (a.samplerate, a.channels)
    if fmt == "flac":
        assert b.frames == a.frames
    else:
        # Both went through the same encoder from the same frame count; lossy
        # decoded lengths can still differ by the codec's framing.
        assert abs(b.frames - a.frames) <= 1152


async def test_no_grid_means_no_click_file_not_an_error(client, jobs_dir):
    skip_without_ffmpeg()
    _make_job(jobs_dir, grid=False)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1")
    assert r.status_code == 200
    assert "Clicky_click.wav" not in _zip(r.content).namelist()


def test_the_click_entry_cannot_collide_with_a_stem():
    assert CLICK_STEM_NAME == "click"
    assert CLICK_STEM_NAME not in (*STEM_NAMES, *EXTRA_STEM_NAMES, "original", "mix")


async def test_the_zip_sums_to_the_mix_export(client, jobs_dir):
    """The zip's files at unity sum to the mix export of the same stems with
    the same click, so dropping the zip into a DAW gives the exported mix."""
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    # The mix's click ends at the grid's recorded duration; on a real song that
    # is the stems' length, so make it so here.
    (jobs_dir / JOB / "stems" / "beats.json").write_text(
        json.dumps({**GRID, "duration": STEM_SECONDS}), encoding="utf-8"
    )
    q = "click=1&click_gain=0.6&click_sound=woodblock"
    async with client as c:
        z = _zip((await c.get(f"/api/jobs/{JOB}/stems/all.zip?{q}")).content)
        mix = _wav(
            (await c.get(f"/api/jobs/{JOB}/mixdown.wav?stems=vocals,drums&gains=1,1&{q}")).content
        )
    total = sum(
        sf.read(io.BytesIO(z.read(f"Clicky_{n}.wav")))[0] for n in ("vocals", "drums", "click")
    )
    assert total.shape == mix.shape
    assert np.max(np.abs(total - mix)) < 4 * INT16_LSB


# ── The sound, across the export routes ──


@pytest.mark.parametrize(
    "path",
    [
        "stems/all.zip?click=1&click_sound=bogus",
        "stems/all.zip?click_sound=..%2F..%2Fx",
        "mixdown.wav?stems=drums&gains=1&click=1&click_sound=Classic",
        "mixdown.wav?stems=drums&gains=1&click_sound=" + "x" * 33,
        "video.mp4?stems=drums&gains=1&click=1&click_sound=nope",
    ],
)
async def test_an_unknown_click_sound_is_a_422(client, jobs_dir, path):
    _make_job(jobs_dir)
    (jobs_dir / JOB / "video.mp4").write_bytes(b"\x00")
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/{path}")
    assert r.status_code == 422


async def test_the_mix_export_uses_the_chosen_sound(client, jobs_dir):
    """With the stem at gain 0 the export is the click alone: the chosen
    preset's render at the click level, not Classic's."""
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    out = {}
    async with client as c:
        for sound in ("classic", "cowbell"):
            r = await c.get(
                f"/api/jobs/{JOB}/mixdown.wav?stems=drums&gains=0&click=1&click_gain=0.5"
                f"&click_sound={sound}"
            )
            assert r.status_code == 200
            out[sound] = _wav(r.content)[:, 0]
    assert not np.array_equal(out["classic"], out["cowbell"])
    voice = cs.render_voice("cowbell", LEVEL_DOWNBEAT, SR) * 0.5
    start = int(round(GRID["beats"][0] * SR))
    seg = out["cowbell"][start : start + len(voice)]
    assert np.max(np.abs(seg - voice)) < 4 * INT16_LSB


def test_the_click_lane_renders_the_chosen_sound(jobs_dir):
    _make_job(jobs_dir)
    a = stems_mod._click_lane(JOB, True, 1.0, -1, 0.6)
    b = stems_mod._click_lane(JOB, True, 1.0, -1, 0.6, sound="soft")
    ci = stems_mod._click_lane(JOB, False, 1.0, -1, 0.6, count_in_bars=1, sound="soft")
    assert a.path != b.path
    assert a.path.read_bytes() != b.path.read_bytes()
    assert ci is not None and ci.path not in (a.path, b.path)


# ── The exported click's level is the live click's ──
#
# Live, the click is a mono AudioBuffer through a GainNode at the click volume
# into the stereo master, and Web Audio's mono-to-stereo up-mix copies it to
# both channels at full level. Every export must match that on each channel.


def _live_click(level: int, gain: float) -> np.ndarray:
    """The live Classic click on one channel: the browser's buffer times the volume."""
    return cs.render_voice("classic", level, SR) * gain


def _db(a: np.ndarray, b: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(a**2)) / np.sqrt(np.mean(b**2))))


# (query, the first click's start sample in the export, its level).
_LEVEL_CASES = {
    "mix": ("", int(round(GRID["beats"][0] * SR)), beat_level(0, GRID["bars"], -1)),
    # The region starts on the second beat, so its first click is at sample 0.
    "region": ("&start=1.0&end=3.0", 0, beat_level(1, GRID["bars"], -1)),
    # The count-in's first click is its downbeat, at sample 0.
    "count_in": ("&count_in=1", 0, LEVEL_DOWNBEAT),
}


@pytest.mark.parametrize("ext", ["wav", "flac"])
@pytest.mark.parametrize("case", sorted(_LEVEL_CASES))
async def test_the_exported_click_is_at_the_live_level_on_each_channel(client, jobs_dir, case, ext):
    """Each channel carries the live click's level within 0.05 dB (16-bit
    rounding); it was 3.01 dB lower while amix did the mono-to-stereo step."""
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    gain = 0.6
    query, at, level = _LEVEL_CASES[case]
    async with client as c:
        r = await c.get(
            f"/api/jobs/{JOB}/mixdown.{ext}?stems=drums&gains=0&click=1&click_gain={gain}{query}"
        )
    assert r.status_code == 200, r.text
    out, _ = sf.read(io.BytesIO(r.content))
    live = _live_click(level, gain)
    assert out.ndim == 2 and out.shape[1] == 2
    for ch in (0, 1):
        diff = _db(out[at : at + len(live), ch], live)
        assert diff == pytest.approx(0.0, abs=LIVE_LEVEL_TOLERANCE_DB), (case, ch, diff)


async def test_the_zip_click_is_at_the_live_level_on_each_channel(client, jobs_dir):
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    gain = 0.6
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1&click_gain={gain}")
    click, _ = sf.read(io.BytesIO(_zip(r.content).read("Clicky_click.wav")))
    live = _live_click(beat_level(0, GRID["bars"], -1), gain)
    at = int(round(GRID["beats"][0] * SR))
    for ch in (0, 1):
        diff = _db(click[at : at + len(live), ch], live)
        assert diff == pytest.approx(0.0, abs=LIVE_LEVEL_TOLERANCE_DB), (ch, diff)


def _tiny_video(dest: Path, seconds: float) -> None:
    """A silent black MPEG-4 video, the job's preserved video stream."""
    subprocess.run(
        [
            ffmpeg_executable(),
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c=black:s=64x64:r=10:d={seconds}",
            "-c:v",
            "mpeg4",
            "-y",
            str(dest),
        ],
        check=True,
        timeout=60,
    )


def _decode_stereo(path: Path) -> np.ndarray:
    cmd = [ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-i", str(path), "-vn"]
    pcm = subprocess.run(
        [*cmd, "-f", "f32le", "-ac", "2", "pipe:1"], capture_output=True, check=True, timeout=60
    ).stdout
    return np.frombuffer(pcm, dtype="<f4").reshape(-1, 2)


async def test_the_video_export_click_is_at_the_live_level_on_each_channel(
    client, jobs_dir, tmp_path
):
    """AAC, so compared by the RMS of the whole click track (timing-blind, the
    encoder's priming does not matter), within 0.2 dB."""
    skip_without_ffmpeg()
    _make_job(jobs_dir)
    _tiny_video(jobs_dir / JOB / "video.mp4", STEM_SECONDS)
    gain = 0.6
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/video.mp4?stems=drums&gains=0&click=1&click_gain={gain}")
    assert r.status_code == 200, r.text
    out = tmp_path / "out.mp4"
    out.write_bytes(r.content)
    x = _decode_stereo(out)
    mono = render_click_wav(
        tmp_path / "live.wav", GRID["beats"], GRID["bars"], GRID["duration"], sample_rate=SR
    )
    live, _ = sf.read(mono)
    for ch in (0, 1):
        diff = _db(x[:, ch], live * gain) + 10 * np.log10(len(x) / len(live))
        assert diff == pytest.approx(0.0, abs=0.2), (ch, diff)
