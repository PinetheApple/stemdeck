"""Click sounds and the click's level, through the export routes.

Ported from upstream PR 831 (sounds) and upstream PR 837 (the exported click
at the level the app plays it), onto this fork's routes:

- an unknown sound is a 422 everywhere a click is rendered, and the mix export
  uses the chosen sound;
- every export carries the click on each channel at the live level.

The stems zip's click file is in test_click_stem_zip.py.
"""

from __future__ import annotations

import io
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.api import stems as stems_mod
from app.core.config import CLICK_GAIN_DEFAULT, CLICK_MULT_DEFAULT, ffmpeg_executable
from app.pipeline import click_sounds as cs
from app.pipeline.click_render import ACCENT_AUTO, LEVEL_DOWNBEAT, beat_level, render_click_wav
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
)
from tests.ffmpeg_probe import skip_without_ffmpeg

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
    make_job(jobs_dir)
    (jobs_dir / JOB / "video.mp4").write_bytes(b"\x00")
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/{path}")
    assert r.status_code == 422


async def test_the_mix_export_uses_the_chosen_sound(client, jobs_dir):
    """With the stem at gain 0 the export is the click alone: the chosen
    preset's render at the click level, not Classic's."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    out = {}
    async with client as c:
        for sound in ("classic", "cowbell"):
            r = await c.get(
                f"/api/jobs/{JOB}/mixdown.wav?stems=drums&gains=0&click=1&click_gain=0.5"
                f"&click_sound={sound}"
            )
            assert r.status_code == 200
            out[sound] = read_wav(r.content)[:, 0]
    assert not np.array_equal(out["classic"], out["cowbell"])
    voice = cs.render_voice("cowbell", LEVEL_DOWNBEAT, SR) * 0.5
    start = int(round(GRID["beats"][0] * SR))
    seg = out["cowbell"][start : start + len(voice)]
    assert np.max(np.abs(seg - voice)) < 4 * INT16_LSB


def test_the_click_lane_renders_the_chosen_sound(jobs_dir):
    make_job(jobs_dir)
    args = (JOB, True, CLICK_MULT_DEFAULT, ACCENT_AUTO, CLICK_GAIN_DEFAULT)
    a = stems_mod._click_lane(*args)
    b = stems_mod._click_lane(*args, sound="soft")
    ci = stems_mod._click_lane(
        JOB,
        False,
        CLICK_MULT_DEFAULT,
        ACCENT_AUTO,
        CLICK_GAIN_DEFAULT,
        count_in_bars=1,
        sound="soft",
    )
    named = stems_mod._click_lane(*args, sound=cs.DEFAULT_CLICK_SOUND)
    assert named.path == a.path, "a client that sends classic reuses the cached click"
    assert a.path != b.path
    assert a.path.read_bytes() != b.path.read_bytes()
    assert ci is not None and ci.path not in (a.path, b.path)


# ── The exported click's level is the live click's ──
# Web Audio up-mixes the live mono click to both channels at full level.


# (query, the first click's start sample in the export, its level).
_LEVEL_CASES = {
    "mix": ("", int(round(GRID["beats"][0] * SR)), beat_level(0, GRID["bars"], ACCENT_AUTO)),
    # The region starts on the second beat, so its first click is at sample 0.
    "region": ("&start=1.0&end=3.0", 0, beat_level(1, GRID["bars"], ACCENT_AUTO)),
    # The count-in's first click is its downbeat, at sample 0.
    "count_in": ("&count_in=1", 0, LEVEL_DOWNBEAT),
}


@pytest.mark.parametrize("ext", ["wav", "flac"])
@pytest.mark.parametrize("case", sorted(_LEVEL_CASES))
async def test_the_exported_click_is_at_the_live_level_on_each_channel(client, jobs_dir, case, ext):
    """Each channel carries the live click's level within 0.05 dB (16-bit
    rounding)."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    gain = CLICK_GAIN_DEFAULT
    query, at, level = _LEVEL_CASES[case]
    async with client as c:
        r = await c.get(
            f"/api/jobs/{JOB}/mixdown.{ext}?stems=drums&gains=0&click=1&click_gain={gain}{query}"
        )
    assert r.status_code == 200, r.text
    out, _ = sf.read(io.BytesIO(r.content))
    live = live_click(level, gain)
    assert out.ndim == 2 and out.shape[1] == 2
    for ch in (0, 1):
        diff = db(out[at : at + len(live), ch], live)
        assert diff == pytest.approx(0.0, abs=LIVE_LEVEL_TOLERANCE_DB), (case, ch, diff)


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
        timeout=FFMPEG_TIMEOUT_S,
    )


def _decode_stereo(path: Path) -> np.ndarray:
    cmd = [ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-i", str(path), "-vn"]
    pcm = subprocess.run(
        [*cmd, "-f", "f32le", "-ac", "2", "pipe:1"],
        capture_output=True,
        check=True,
        timeout=FFMPEG_TIMEOUT_S,
    ).stdout
    return np.frombuffer(pcm, dtype="<f4").reshape(-1, 2)


async def test_the_video_export_click_is_at_the_live_level_on_each_channel(
    client,
    jobs_dir,
    tmp_path,
):
    """AAC, so compared by the RMS of the whole click track (timing-blind, the
    encoder's priming does not matter), within 0.2 dB."""
    skip_without_ffmpeg()
    make_job(jobs_dir)
    _tiny_video(jobs_dir / JOB / "video.mp4", STEM_SECONDS)
    gain = CLICK_GAIN_DEFAULT
    async with client as c:
        r = await c.get(f"/api/jobs/{JOB}/video.mp4?stems=drums&gains=0&click=1&click_gain={gain}")
    assert r.status_code == 200, r.text
    out = tmp_path / "out.mp4"
    out.write_bytes(r.content)
    x = _decode_stereo(out)
    mono = render_click_wav(
        tmp_path / "live.wav",
        GRID["beats"],
        GRID["bars"],
        GRID["duration"],
        sample_rate=SR,
    )
    live, _ = sf.read(mono)
    for ch in (0, 1):
        diff = db(x[:, ch], live * gain) + 10 * np.log10(len(x) / len(live))
        assert diff == pytest.approx(0.0, abs=0.2), (ch, diff)
