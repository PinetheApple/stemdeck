"""app.pipeline.take_render: the raw capture becomes a playable lane in the
stems' format, placed on the song timeline to the sample."""

from __future__ import annotations

import json
import struct
import subprocess

import numpy as np
import pytest
import soundfile as sf

from app.core.config import ffmpeg_executable
from app.core.stem_files import MP3_STEMS_MARKER
from app.core.takes_config import TAKE_RATE
from app.pipeline import take_render
from tests.ffmpeg_probe import skip_without_ffmpeg

CAPTURE_RATE = 48000
SONG_FRAMES = TAKE_RATE * 4


@pytest.fixture
def needs_ffmpeg():
    skip_without_ffmpeg()


def _raw_capture(path, impulse_frames, frames=CAPTURE_RATE * 2):
    """One impulse per channel, at that channel's frame."""
    pcm = np.zeros((frames, len(impulse_frames)), dtype=np.float32)
    for channel, frame in enumerate(impulse_frames):
        pcm[frame, channel] = 0.9
    path.write_bytes(pcm.tobytes())
    return path


def _render(tmp_path, placement, impulse_frames):
    channels = len(impulse_frames)
    part = _raw_capture(tmp_path / "audio.part", impulse_frames)
    raw = tmp_path / "audio.raw.wav"
    take_render.assemble_raw_wav(part, raw, CAPTURE_RATE, channels)
    out = tmp_path / "audio.wav"
    take_render.render_take_audio(raw, out, placement, SONG_FRAMES, CAPTURE_RATE, channels)
    return out


def test_assemble_raw_wav_writes_a_float_header(tmp_path):
    folder = tmp_path / "take"
    folder.mkdir()
    part = _raw_capture(folder / "audio.part", (10, 20), frames=100)
    raw = folder / "audio.raw.wav"
    take_render.assemble_raw_wav(part, raw, CAPTURE_RATE, 2)
    info = sf.info(str(raw))
    assert (info.samplerate, info.channels, info.frames, info.subtype) == (
        CAPTURE_RATE,
        2,
        100,
        "FLOAT",
    )
    assert struct.unpack("<H", raw.read_bytes()[20:22]) == (3,)
    assert sorted(p.name for p in folder.iterdir()) == ["audio.part", "audio.raw.wav"]


def test_filter_trims_a_take_that_starts_before_the_song():
    chain = take_render.take_audio_filter(-0.5, SONG_FRAMES, 1)
    assert "atrim=start_sample=22050" in chain
    assert chain.startswith("pan=stereo|c0=c0|c1=c0")
    assert chain.endswith(f"atrim=end_sample={SONG_FRAMES}")


def test_filter_delays_a_take_that_starts_inside_the_song():
    chain = take_render.take_audio_filter(1.0, SONG_FRAMES, 2)
    assert "adelay=delays=44100S:all=1" in chain
    assert "pan=" not in chain


@pytest.mark.usefixtures("needs_ffmpeg")
@pytest.mark.parametrize("placement", [0.75, -0.25, 0.0])
def test_mono_impulse_lands_on_the_expected_song_sample(tmp_path, placement):
    impulse_frame = CAPTURE_RATE // 2
    out = _render(tmp_path, placement, (impulse_frame,))
    data, rate = sf.read(str(out), dtype="float32", always_2d=True)
    assert rate == TAKE_RATE
    assert data.shape == (SONG_FRAMES, 2)
    expected = round((placement + impulse_frame / CAPTURE_RATE) * TAKE_RATE)
    assert int(np.argmax(np.abs(data[:, 0]))) == expected
    assert np.array_equal(data[:, 0], data[:, 1])


@pytest.mark.usefixtures("needs_ffmpeg")
def test_stereo_impulses_keep_their_channels_and_samples(tmp_path):
    left, right = CAPTURE_RATE // 4, CAPTURE_RATE // 2
    out = _render(tmp_path, 0.5, (left, right))
    data, _ = sf.read(str(out), dtype="float32", always_2d=True)
    assert int(np.argmax(np.abs(data[:, 0]))) == round((0.5 + left / CAPTURE_RATE) * TAKE_RATE)
    assert int(np.argmax(np.abs(data[:, 1]))) == round((0.5 + right / CAPTURE_RATE) * TAKE_RATE)


@pytest.mark.usefixtures("needs_ffmpeg")
def test_take_entirely_outside_the_song_renders_silence_of_song_length(tmp_path):
    out = _render(tmp_path, -10.0, (100,))
    data, _ = sf.read(str(out), dtype="float32", always_2d=True)
    assert data.shape == (SONG_FRAMES, 2)
    assert not data.any()


@pytest.mark.usefixtures("needs_ffmpeg")
def test_render_failure_raises_take_render_error(tmp_path):
    raw = tmp_path / "audio.raw.wav"
    raw.write_bytes(b"not a wav")
    with pytest.raises(take_render.TakeRenderError):
        take_render.render_take_audio(raw, tmp_path / "o.wav", 0.0, SONG_FRAMES, CAPTURE_RATE, 1)
    assert not (tmp_path / "o.wav").exists()


def test_song_frames_reads_the_first_stem_wav(tmp_path):
    stems = tmp_path / "stems"
    stems.mkdir()
    sf.write(str(stems / "drums.wav"), np.zeros((1234, 2), dtype=np.float32), TAKE_RATE)
    assert take_render.song_frames(stems) == 1234


def test_song_frames_is_none_without_stems(tmp_path):
    (tmp_path / "stems").mkdir()
    assert take_render.song_frames(tmp_path / "stems") is None


@pytest.mark.usefixtures("needs_ffmpeg")
def test_song_frames_of_an_mp3_song_comes_from_its_duration(tmp_path):
    stems = tmp_path / "stems"
    stems.mkdir()
    wav = tmp_path / "src.wav"
    sf.write(str(wav), np.zeros((TAKE_RATE * 2, 2), dtype=np.float32), TAKE_RATE)
    subprocess.run(
        [
            ffmpeg_executable(),
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            str(wav),
            str(stems / "vocals.mp3"),
        ],
        check=True,
    )
    (stems / MP3_STEMS_MARKER).write_text("", encoding="utf-8")
    frames = take_render.song_frames(stems)
    assert frames is not None
    assert abs(frames - TAKE_RATE * 2) < TAKE_RATE // 10


@pytest.mark.usefixtures("needs_ffmpeg")
def test_write_peaks_names_the_take(tmp_path):
    out = _render(tmp_path, 0.0, (1000,))
    peaks_path = tmp_path / "peaks.json"
    take_render.write_take_peaks(out, peaks_path, "t0000000a")
    peaks = json.loads(peaks_path.read_text(encoding="utf-8"))
    assert list(peaks) == ["t0000000a"]
    assert len(peaks["t0000000a"]) > 100
    assert all(len(pair) == 2 for pair in peaks["t0000000a"])


def test_an_mp3_songs_length_is_probed_once_per_file(tmp_path, monkeypatch):
    from app.core.stem_files import MP3_STEMS_MARKER
    from app.pipeline import take_render

    stems = tmp_path / "stems"
    stems.mkdir()
    (stems / MP3_STEMS_MARKER).touch()
    mp3 = stems / "drums.mp3"
    mp3.write_bytes(b"not decoded here")
    probes = []

    def probe(path):
        probes.append(path)
        return 1000

    monkeypatch.setattr(take_render, "_probe_frames", probe)
    take_render.song_frames_cache_clear()
    assert take_render.song_frames(stems) == take_render.song_frames(stems) == 1000
    mp3.write_bytes(b"replaced by a new import")
    assert take_render.song_frames(stems) == 1000
    assert len(probes) == 2
