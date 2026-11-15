"""The click file in the stems zip, through the zip route.

Ported from upstream PR 831 (the zip's click file) and upstream PR 837 (the
exported click at the level the app plays it), onto this fork's route: the
zip carries `<song>_click.<ext>` only when asked, and is otherwise byte for
byte what it was; the click file has the stems' exact length, rate and
channels, its onsets on the grid the app clicks to (the user's beat and tempo
edits included), and the zip's files sum to the mix export.
"""

from __future__ import annotations

import io
import json
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.api import stems as stems_mod
from app.core.config import (
    CLICK_GAIN_DEFAULT,
    CLICK_STEM_NAME,
    EXPORT_ENCODE_ARGS,
    EXTRA_STEM_NAMES,
    RENDERED_TRACK_NAMES,
    STEM_FORMAT_MP3,
    STEM_NAMES,
    ffmpeg_executable,
)
from app.core.stem_files import MP3_EXT, MP3_STEMS_MARKER, stem_path
from app.pipeline import click_sounds as cs
from app.pipeline.click_render import ACCENT_AUTO, LEVEL_DOWNBEAT, beat_level
from tests._click_export import (
    FFMPEG_TIMEOUT_S,
    GRID,
    INT16_LSB,
    JOB,
    LIVE_LEVEL_TOLERANCE_DB,
    SR,
    STEM_SECONDS,
    client_fixture,  # noqa: F401 -- fixtures, used by pytest
    db,
    isolate_registry,  # noqa: F401
    jobs_dir_fixture,  # noqa: F401
    live_click,
    make_job,
    read_wav,
    read_zip,
)
from tests.ffmpeg_probe import skip_without_ffmpeg

ONSET_THRESHOLD = 0.02
MP3_FRAME_SAMPLES = 1152
SF_FORMAT_MP3 = "MP3"
ZIP_FORMAT_WAV = "wav"
SONG_SLUG = "Clicky"


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
        voice = cs.render_voice(sound, beat_level(i, bars, ACCENT_AUTO), SR) * gain
        out.append(int(round(t * SR)) + int(np.flatnonzero(np.abs(voice) > ONSET_THRESHOLD)[0]))
    return out


def _entries(zf) -> list[tuple[str, int]]:
    return [(i.filename, i.compress_type) for i in zf.infolist()]


async def test_the_zip_without_click_params_is_the_click_free_zip(client, jobs_dir, tmp_path):
    """No click parameters, and click explicitly off, both give byte for byte
    the zip the click-free builder makes from the same stems."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    stems_dir = jobs_dir / JOB / "stems"
    sources = [
        (name, stem_path(stems_dir, name).resolve())
        for name in (*STEM_NAMES, *EXTRA_STEM_NAMES)
        if stem_path(stems_dir, name).is_file()
    ]
    reference = tmp_path / "reference.zip"
    stems_mod._build_stems_zip(sources, ZIP_FORMAT_WAV, reference, SONG_SLUG)
    async with client as c:
        absent = await c.get(f"/api/jobs/{JOB}/stems/all.zip")
        off = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=0")
    assert absent.status_code == off.status_code == 200
    want = read_zip(reference.read_bytes())
    assert _entries(read_zip(absent.content)) == _entries(want)
    assert absent.content == off.content == reference.read_bytes()


# ── The stems zip ──


async def test_the_zip_is_byte_for_byte_unchanged_without_the_click(client, jobs_dir):
    """Click off (or absent) builds exactly the zip it always did, whatever
    other click parameters ride along."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    async with client as c:
        plain = await c.get(f"/api/jobs/{JOB}/stems/all.zip")
        off = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=0&click_sound=cowbell&click_gain=2")
    assert plain.status_code == off.status_code == 200
    assert sorted(read_zip(plain.content).namelist()) == ["Clicky_drums.wav", "Clicky_vocals.wav"]
    assert plain.content == off.content


@pytest.mark.parametrize("sound", ["classic", "rimshot"])
async def test_the_zip_click_is_sample_aligned_with_the_stems(client, jobs_dir, sound):
    """Same length, rate and channels as the stems, onsets on the grid's beats
    within one sample, at the click's export level."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    gain = CLICK_GAIN_DEFAULT
    async with client as c:
        r = await c.get(
            f"/api/jobs/{JOB}/stems/all.zip?click=1&click_gain={gain}&click_sound={sound}"
        )
    assert r.status_code == 200
    zf = read_zip(r.content)
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
    make_job(jobs_dir)
    edited = [0.25, 0.75, 1.25, 1.75]
    (jobs_dir / JOB / "stems" / "beats.user.json").write_text(
        json.dumps({"beats": edited, "bars": []}),
        encoding="utf-8",
    )
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1&click_mult=2&click_accent=0")
    click, _ = sf.read(io.BytesIO(read_zip(r.content).read("Clicky_click.wav")))
    # x2 inserts midpoints: 0.25, 0.5, 0.75 ... 1.75 = 7 clicks, 0.25 s apart.
    got = _onsets(click[:, 0], gap=0.1)
    assert len(got) == 7
    assert abs(got[0] - 0.25 * SR) < 0.002 * SR
    assert abs(got[1] - 0.5 * SR) < 0.002 * SR


async def test_the_zip_click_follows_a_user_tempo_edit(client, jobs_dir):
    """A constant tempo the user set (100 BPM from 0.3 s) replaces the detected
    beats in the click file, as it does in playback and in the mix export."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    tempo = {"mode": "constant", "bpm": 100.0, "anchor": 0.3, "beats_per_bar": 4}
    (jobs_dir / JOB / "stems" / "beats.user.json").write_text(
        json.dumps({"tempo": tempo}),
        encoding="utf-8",
    )
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1&click_gain={CLICK_GAIN_DEFAULT}")
    click, _ = sf.read(io.BytesIO(read_zip(r.content).read("Clicky_click.wav")))
    beats = [0.3, 0.9, 1.5, 2.1, 2.7]
    bars = [{"beat": 0, "beats_per_bar": 4}]
    expected = _expected_onsets(beats, bars, "classic", CLICK_GAIN_DEFAULT)
    got = _onsets(click[:, 0])
    assert len(got) == len(expected), (got, expected)
    assert max(abs(g - e) for g, e in zip(got, expected, strict=True)) <= 1, (got, expected)


async def test_the_zip_click_is_the_grid_the_app_clicks_to(client, jobs_dir):
    """A grid analysed before tempo existed is fitted and continued over the
    song when read; the zip clicks every beat GET /beats serves, the one
    continued before 0.5 s included."""
    skip_without_ffmpeg()
    make_job(jobs_dir, grid=False)
    legacy = {k: v for k, v in GRID.items() if k != "tempo"}
    (jobs_dir / JOB / "stems" / "beats.json").write_text(json.dumps(legacy), encoding="utf-8")
    async with client as c:
        served = (await c.get(f"/api/jobs/{JOB}/beats")).json()
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1&click_gain={CLICK_GAIN_DEFAULT}")
    assert len(served["beats"]) > len(GRID["beats"]), "the served grid is the continued one"
    click, _ = sf.read(io.BytesIO(read_zip(r.content).read("Clicky_click.wav")))
    expected = _expected_onsets(served["beats"], served["bars"], "classic", CLICK_GAIN_DEFAULT)
    got = _onsets(click[:, 0])
    assert len(got) == len(expected), (got, expected)
    assert max(abs(g - e) for g, e in zip(got, expected, strict=True)) <= 1, (got, expected)


@pytest.mark.parametrize("fmt", ["mp3", "flac", "ogg"])
async def test_the_zip_click_is_in_the_zips_format_and_length(client, jobs_dir, fmt):
    skip_without_ffmpeg()
    make_job(jobs_dir)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?format={fmt}&click=1&click_sound=woodblock")
    assert r.status_code == 200
    zf = read_zip(r.content)
    assert f"Clicky_click.{fmt}" in zf.namelist()
    with zf.open(f"Clicky_drums.{fmt}") as s, zf.open(f"Clicky_click.{fmt}") as k:
        a, b = sf.info(io.BytesIO(s.read())), sf.info(io.BytesIO(k.read()))
    assert (b.samplerate, b.channels) == (a.samplerate, a.channels)
    if fmt == "flac":
        assert b.frames == a.frames
    else:
        # Both went through the same encoder from the same frame count; lossy
        # decoded lengths can still differ by the codec's framing.
        assert abs(b.frames - a.frames) <= MP3_FRAME_SAMPLES


def _store_stems_as_mp3(jobs_dir: Path) -> None:
    """The job's stems as an MP3-stored song keeps them: MP3s and the marker, no WAVs."""
    stems = jobs_dir / JOB / "stems"
    for wav in stems.glob("*.wav"):
        subprocess.run(
            [
                ffmpeg_executable(),
                "-nostdin",
                "-loglevel",
                "error",
                "-i",
                str(wav),
                *EXPORT_ENCODE_ARGS[STEM_FORMAT_MP3],
                str(wav.with_suffix(MP3_EXT)),
            ],
            check=True,
            timeout=FFMPEG_TIMEOUT_S,
        )
        wav.unlink()
    (stems / MP3_STEMS_MARKER).touch()


async def test_the_zip_click_of_mp3_stored_stems_is_an_mp3_beside_them(client, jobs_dir):
    """Stems stored as MP3 go into an MP3 zip as they are, and the click file
    joins them as an MP3 with their rate, channels and length."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    _store_stems_as_mp3(jobs_dir)
    stored = (jobs_dir / JOB / "stems" / f"drums{MP3_EXT}").read_bytes()
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?format={STEM_FORMAT_MP3}&click=1")
    assert r.status_code == 200
    zf = read_zip(r.content)
    assert sorted(zf.namelist()) == ["Clicky_click.mp3", "Clicky_drums.mp3", "Clicky_vocals.mp3"]
    assert zf.read("Clicky_drums.mp3") == stored, "a stored MP3 is zipped as it is"
    stem = sf.info(io.BytesIO(zf.read("Clicky_drums.mp3")))
    click = sf.info(io.BytesIO(zf.read("Clicky_click.mp3")))
    assert click.format == stem.format == SF_FORMAT_MP3, "MP3 data, not just an .mp3 name"
    assert (click.samplerate, click.channels) == (stem.samplerate, stem.channels)
    assert abs(click.frames - stem.frames) <= MP3_FRAME_SAMPLES


async def test_no_grid_means_no_click_file_not_an_error(client, jobs_dir):
    skip_without_ffmpeg()
    make_job(jobs_dir, grid=False)
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1")
    assert r.status_code == 200
    assert "Clicky_click.wav" not in read_zip(r.content).namelist()


def test_the_click_entry_cannot_collide_with_a_stem():
    assert CLICK_STEM_NAME == "click"
    assert CLICK_STEM_NAME not in (*STEM_NAMES, *EXTRA_STEM_NAMES, *RENDERED_TRACK_NAMES)


async def test_the_zip_sums_to_the_mix_export(client, jobs_dir):
    """The zip's files at unity sum to the mix export of the same stems with
    the same click, so dropping the zip into a DAW gives the exported mix."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    # The mix's click ends at the grid's recorded duration; on a real song that
    # is the stems' length, so make it so here.
    (jobs_dir / JOB / "stems" / "beats.json").write_text(
        json.dumps({**GRID, "duration": STEM_SECONDS}),
        encoding="utf-8",
    )
    q = f"click=1&click_gain={CLICK_GAIN_DEFAULT}&click_sound=woodblock"
    async with client as c:
        z = read_zip((await c.get(f"/api/jobs/{JOB}/stems/all.zip?{q}")).content)
        mix = read_wav(
            (await c.get(f"/api/jobs/{JOB}/mixdown.wav?stems=vocals,drums&gains=1,1&{q}")).content
        )
    total = sum(
        sf.read(io.BytesIO(z.read(f"Clicky_{n}.wav")))[0] for n in ("vocals", "drums", "click")
    )
    assert total.shape == mix.shape
    assert np.max(np.abs(total - mix)) < 4 * INT16_LSB


async def test_the_zip_click_is_at_the_live_level_on_each_channel(client, jobs_dir):
    skip_without_ffmpeg()
    make_job(jobs_dir)
    gain = CLICK_GAIN_DEFAULT
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/stems/all.zip?click=1&click_gain={gain}")
    click, _ = sf.read(io.BytesIO(read_zip(r.content).read("Clicky_click.wav")))
    live = live_click(beat_level(0, GRID["bars"], ACCENT_AUTO), gain)
    at = int(round(GRID["beats"][0] * SR))
    for ch in (0, 1):
        diff = db(click[at : at + len(live), ch], live)
        assert diff == pytest.approx(0.0, abs=LIVE_LEVEL_TOLERANCE_DB), (ch, diff)
