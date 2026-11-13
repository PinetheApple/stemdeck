"""Click sounds: the preset table and its synthesis (ported from upstream PR 831).

- The preset table: parsed from static/js/clickSounds.js, validated, Classic is
  the default and still says what the old constants said.
- Classic is unchanged: its renders are byte-identical to the renderer before
  presets existed (fingerprints taken on this fork's main before the port).
- Every preset: non-silent, finite, the right length, a downbeat that differs
  from a plain beat, never clipping, deterministic, and level-matched to
  Classic.
- Drift: tests/fixtures/click_sounds.json is what Python measures now; the JS
  half (tests/js/click-sounds.test.mjs) holds the browser to the same file.

The export routes are in tests/test_click_sounds_api.py.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.core.config import ffmpeg_executable
from app.pipeline import click_render
from app.pipeline import click_sounds as cs
from app.pipeline.click_render import (
    LEVEL_DOWNBEAT,
    LEVEL_GROUP,
    LEVEL_WEAK,
    render_click_wav,
    render_count_in_wav,
)
from tests.ffmpeg_probe import skip_without_ffmpeg

sys.path.insert(0, str(Path(__file__).parent))
from _click_sounds_fixture import build as build_fixture  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "click_sounds.json"
SR = 44100
LEVELS = (LEVEL_WEAK, LEVEL_GROUP, LEVEL_DOWNBEAT)

# ── The table ──


def test_the_table_parses_and_lists_the_five_presets_classic_first():
    assert cs.CLICK_SOUND_IDS == ("classic", "woodblock", "rimshot", "soft", "cowbell")
    assert cs.DEFAULT_CLICK_SOUND == "classic"


def test_classic_in_the_table_is_the_old_click():
    """The default's numbers are the constants the click always had. A change
    here is a change to every existing user's click."""
    classic = cs._BY_ID["classic"]
    assert classic["gain"] == 1.0
    for level, freq, peak in (
        ("beat", click_render.CLICK_FREQ, click_render.CLICK_PEAK),
        ("group", click_render.GROUP_FREQ, click_render.GROUP_PEAK),
        ("accent", click_render.ACCENT_FREQ, click_render.ACCENT_PEAK),
    ):
        (comp,) = classic["voices"][level]
        assert comp == {
            "type": "sine",
            "freq": freq,
            "attack": click_render.CLICK_ATTACK,
            "decay": click_render.CLICK_DECAY,
            "peak": peak,
        }
    assert cs.FLOOR == click_render.RAMP_FLOOR


@pytest.mark.parametrize(
    "text",
    [
        "export const X = {};",
        "/* CLICK_SOUNDS_JSON_BEGIN */ {'presets': []} /* CLICK_SOUNDS_JSON_END */",
        '/* CLICK_SOUNDS_JSON_BEGIN */ {"default": "a", "floor": 0.0001, "presets": []}'
        " /* CLICK_SOUNDS_JSON_END */",
    ],
)
def test_a_malformed_table_is_refused_not_defaulted(text):
    with pytest.raises(cs.ClickSoundTableError):
        cs.parse_table(text)


def test_a_sample_preset_is_refused_until_it_is_implemented():
    table = json.loads(cs._JSON_BLOCK.search(cs.CLICK_SOUNDS_TABLE.read_text()).group(1))
    table["presets"][1]["kind"] = "sample"
    text = f"/* CLICK_SOUNDS_JSON_BEGIN */ {json.dumps(table)} /* CLICK_SOUNDS_JSON_END */"
    with pytest.raises(cs.ClickSoundTableError):
        cs.parse_table(text)


def test_an_unknown_sound_is_a_key_error_not_the_default():
    with pytest.raises(KeyError):
        cs.render_voice("../../etc/passwd", LEVEL_WEAK, SR)


# ── Classic is unchanged ──

# sha256 of each render, taken on main before presets existed.
_CLASSIC_FINGERPRINTS = {
    "44100": "93183f477c35b7259bda9465a462b430f6af687af7a03e93d3e88629b2e30222",
    "48000": "7cd370a6e71a8f588060c7ceb2306a8adbd62cc4c0530021eb4f87cca0c47270",
    "grouped": "9e9f68eb93e78009e3c6a6270aa1f69ec9c50939955424a303046f36637110ef",
    "countin": "925d342ca0162d2df576b67195e42413992365cfba3cd356b4ae8462cbf9bf83",
}
_BEATS = [0.5 + i * 0.5 for i in range(16)]
_BARS = [{"beat": 0, "beats_per_bar": 4}]


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def test_the_default_sound_renders_byte_for_byte_what_it_did_before_presets(tmp_path):
    for sr in (44100, 48000):
        p = render_click_wav(tmp_path / f"{sr}.wav", _BEATS, _BARS, 9.0, sample_rate=sr)
        assert _sha(p) == _CLASSIC_FINGERPRINTS[str(sr)], f"classic click changed at {sr} Hz"
    p = render_click_wav(tmp_path / "g.wav", _BEATS, [], 9.0, accent_mode=7, groups=[3, 2, 2])
    assert _sha(p) == _CLASSIC_FINGERPRINTS["grouped"]
    p, lead = render_count_in_wav(
        tmp_path / "ci.wav", _BEATS, _BARS, 9.0, count_in_bars=1, start=2.0, end=6.0
    )
    assert lead == 2.0
    assert _sha(p) == _CLASSIC_FINGERPRINTS["countin"]


def test_naming_classic_is_the_same_as_naming_nothing(tmp_path):
    a = render_click_wav(tmp_path / "a.wav", _BEATS, _BARS, 9.0)
    b = render_click_wav(tmp_path / "b.wav", _BEATS, _BARS, 9.0, sound="classic")
    assert _sha(a) == _sha(b)
    assert click_render.cache_key("j", _BEATS, _BARS, 9.0, SR, 1.0, -1) == click_render.cache_key(
        "j", _BEATS, _BARS, 9.0, SR, 1.0, -1, sound="classic"
    ), "a classic export must keep the cache key it always had"


# ── Every preset ──


@pytest.mark.parametrize("sound", cs.CLICK_SOUND_IDS)
def test_every_preset_voice_is_audible_finite_and_short(sound):
    for level in LEVELS:
        v = cs.render_voice(sound, level, SR)
        assert np.all(np.isfinite(v))
        assert 0.02 * SR <= len(v) <= 0.2 * SR, "a click is a transient, not a note"
        assert np.max(np.abs(v)) > 0.2, "silent voice"
        # Starts from (near) silence and ends there: no step at either edge.
        assert abs(v[0]) < 1e-3 and np.max(np.abs(v[-8:])) < 2e-3


@pytest.mark.parametrize("sound", cs.CLICK_SOUND_IDS)
def test_the_downbeat_differs_from_a_plain_beat(sound):
    accent = cs.render_voice(sound, LEVEL_DOWNBEAT, SR)
    beat = cs.render_voice(sound, LEVEL_WEAK, SR)
    group = cs.render_voice(sound, LEVEL_GROUP, SR)

    def centroid(x):
        # Power-weighted: a magnitude-weighted centroid of a 35 ms burst is
        # dominated by the truncation's broadband sidelobes, not its pitch.
        power = np.abs(np.fft.rfft(x, n=16384)) ** 2
        return float(np.sum(np.fft.rfftfreq(16384, 1 / SR) * power) / np.sum(power))

    # Higher and louder, with the group start between the two (#595).
    assert centroid(accent) > centroid(group) > centroid(beat)
    assert np.max(np.abs(accent)) > np.max(np.abs(group)) > np.max(np.abs(beat))


@pytest.mark.parametrize("sound", cs.CLICK_SOUND_IDS)
@pytest.mark.parametrize("sr", [22050, 44100, 48000, 96000])
def test_no_preset_clips_at_full_click_volume(sound, sr):
    for level in LEVELS:
        assert np.max(np.abs(cs.render_voice(sound, level, sr))) < 0.99


@pytest.mark.parametrize("sound", cs.CLICK_SOUND_IDS)
def test_a_render_is_deterministic(sound, tmp_path):
    a = render_click_wav(tmp_path / "a.wav", _BEATS, _BARS, 9.0, sound=sound)
    cs._voice_cached.cache_clear()
    b = render_click_wav(tmp_path / "b.wav", _BEATS, _BARS, 9.0, sound=sound)
    assert _sha(a) == _sha(b)


def test_presets_render_differently_and_key_their_own_cache(tmp_path):
    shas = {
        s: _sha(render_click_wav(tmp_path / f"{s}.wav", _BEATS, _BARS, 9.0, sound=s))
        for s in cs.CLICK_SOUND_IDS
    }
    assert len(set(shas.values())) == len(shas)
    keys = {
        click_render.cache_key("j", _BEATS, _BARS, 9.0, SR, 1.0, -1, sound=s)
        for s in cs.CLICK_SOUND_IDS
    }
    assert len(keys) == len(cs.CLICK_SOUND_IDS)


def _bar_loop(sound: str, bars: int = 8) -> np.ndarray:
    """A 4/4 bar at 120 BPM, repeated: the downbeat and three beats."""
    buf = np.zeros(int(bars * 2.0 * SR))
    for b in range(bars * 4):
        v = cs.render_voice(sound, LEVEL_DOWNBEAT if b % 4 == 0 else LEVEL_WEAK, SR)
        s = int(b * 0.5 * SR)
        buf[s : s + len(v)] += v
    return buf


@pytest.mark.parametrize("sound", cs.CLICK_SOUND_IDS[1:])
def test_presets_are_level_matched_to_classic_by_rms(sound):
    """RMS of one bar within 1.5 dB of Classic (measured: 0.95 dB at most).
    The presets were matched by loudness (the next test); RMS is the check
    that needs no ffmpeg."""

    def rms_db(x):
        return 20 * np.log10(np.sqrt(np.mean(x[: int(2 * SR)] ** 2)))

    assert abs(rms_db(_bar_loop(sound)) - rms_db(_bar_loop("classic"))) < 1.5


def _lufs(buf: np.ndarray, tmp_path: Path) -> float:
    import re

    p = tmp_path / "loop.wav"
    sf.write(p, buf, SR, subtype="FLOAT")
    r = subprocess.run(
        [ffmpeg_executable(), "-nostats", "-i", str(p), "-af", "ebur128", "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", r.stderr)[-1])


def test_presets_are_level_matched_to_classic_by_loudness(tmp_path):
    """Integrated loudness (EBU R128) of a 16 s 4/4 loop, the measurement the
    preset gains were set by: every preset within 0.5 LU of Classic
    (measured: -27.8 LUFS for all, woodblock -27.7)."""
    skip_without_ffmpeg()
    ref = _lufs(_bar_loop("classic"), tmp_path)
    for sound in cs.CLICK_SOUND_IDS[1:]:
        assert abs(_lufs(_bar_loop(sound), tmp_path) - ref) <= 0.5, sound


# ── Drift between the two renderers ──


def test_the_committed_drift_fixture_matches_what_python_measures():
    assert FIXTURE.is_file(), "drift fixture is missing; regenerate it (see _click_sounds_fixture)"
    committed = json.loads(FIXTURE.read_text(encoding="utf-8"))
    now = build_fixture()
    assert [(v["sound"], v["sampleRate"], v["level"]) for v in committed["voices"]] == [
        (v["sound"], v["sampleRate"], v["level"]) for v in now["voices"]
    ], "the fixture no longer covers every preset; regenerate it"
    for want, got in zip(committed["voices"], now["voices"], strict=True):
        tag = f"{got['sound']} {got['level']} @ {got['sampleRate']}"
        assert got["length"] == want["length"], tag
        assert got["peakIndex"] == want["peakIndex"], tag
        assert got["peak"] == pytest.approx(want["peak"], abs=1e-6), tag
        assert got["envelope"] == pytest.approx(want["envelope"], abs=1e-6), tag
        assert got["centroid"] == pytest.approx(want["centroid"], abs=0.01), tag
        assert got["absSum"] == pytest.approx(want["absSum"], abs=1e-3), tag
