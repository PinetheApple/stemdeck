"""Suggest EQ, the measurement and the fit, on signals whose spectrum is known.

- The gated third-octave analysis: pink noise reads flat, silence and quiet
  passages are gated out, loudness agrees with pyloudnorm.
- The fit: noise already shaped like a target gets nothing; a +6 dB bump at
  250 Hz comes back as a cut there; a dark signal gets a high boost; the fit
  lowers the distance to the target, is close to idempotent and never leaves
  its bounds (band count, gain, Q, the combined curve, the pedals' knobs).
- The hard rule: no boost where the content is missing.
- Loudness-neutral: the suggested EQ rendered through the export's own ffmpeg
  filters changes the measured integrated loudness by under 0.5 LU.
- A lane too short or too quiet is refused, not guessed at.
"""

from __future__ import annotations

import subprocess

import numpy as np
import pyloudnorm as pyln
import pytest
import soundfile as sf

from app.core.config import (
    SUGGEST_COMBINED_MAX_DB,
    SUGGEST_GAIN_MAX_DB,
    SUGGEST_MAX_BANDS_LANE,
    SUGGEST_MIN_GAIN_DB,
    ffmpeg_executable,
)
from app.pipeline import eq_analysis as A
from app.pipeline import eq_fit as F
from app.pipeline.eq_suggest import MERGE, REPLACE, NotEnoughSignal, band_reasons, make_suggestion
from app.pipeline.eq_targets import default_target, get_target, load_targets
from app.pipeline.fx_filters import BELL, HIGHSHELF, LOWCUT, LOWSHELF, Band, Eq, eq_filter
from tests.ffmpeg_probe import skip_without_ffmpeg

SR = A.ANALYSIS_RATE
FC = np.asarray(A.CENTRES_HZ)
FLAT = [0.0] * A.N_BANDS
BALANCED = get_target("mix.balanced").bands_db
BUMP_250 = Band(BELL, 250.0, 6.0, 1.0, 12)
DARK = Band(HIGHSHELF, 4000.0, -8.0, 0.707, 12)
MUD_AND_DARK = [Band(BELL, 300.0, 6.0, 1.0, 12), Band(HIGHSHELF, 6000.0, -6.0, 0.707, 12)]


def shaped_noise(levels_db, seconds=12.0, extra=(), seed=1) -> np.ndarray:
    """Stereo noise whose third-octave levels follow ``levels_db`` (pink =
    flat), through the bands ``extra``. RMS about -20 dBFS."""
    rng = np.random.default_rng(seed)
    n = int(SR * seconds)
    f = np.fft.rfftfreq(n, 1 / SR)
    f[0] = 1.0
    level = np.interp(np.log2(f), np.log2(FC), np.asarray(levels_db, dtype=float))
    mag = np.sqrt(10 ** (level / 10) / f)
    if extra:
        mag = mag * np.sqrt(A.eq_mag2(list(extra), f))
    chans = [np.fft.irfft(np.fft.rfft(rng.standard_normal(n)) * mag, n) for _ in range(2)]
    x = np.stack(chans, 1)
    return (0.1 * x / np.std(x)).astype(np.float32)


def fit_of(x, target, layout=F.FREE, tolerance=1.0, max_bands=SUGGEST_MAX_BANDS_LANE):
    s = A.analyse(x)
    fit = F.fit_eq(s.bands, target, layout, max_bands, tolerance=tolerance)
    bands = [fb.band for fb in fit.bands]
    out = F.neutral_out_db(s.power, bands)
    w = F.weights_for(s.bands)
    before = F.weighted_rms_db(np.asarray(target) - s.bands, w)
    after = F.weighted_rms_db(np.asarray(target) - A.band_levels_after(s.power, bands, out), w)
    return s, bands, before, after


def test_pink_noise_reads_flat_in_third_octaves():
    s = A.analyse(shaped_noise(FLAT))
    b = s.bands - s.bands[17]
    assert np.max(np.abs(b[7:29])) < 0.3
    assert np.max(np.abs(b[:7])) < 1.5


def test_loudness_of_the_gated_spectrum_matches_pyloudnorm():
    x = shaped_noise(BALANCED)
    ref = pyln.Meter(SR).integrated_loudness(x.astype(np.float64))
    assert A.loudness_of_power(A.analyse(x).power) == pytest.approx(ref, abs=0.2)


def test_silence_and_quiet_passages_are_gated_out():
    x = shaped_noise(FLAT, seconds=20)
    loud = A.analyse(x[: SR * 10])
    y = x.copy()
    y[SR * 10 :] = 0.0
    y[SR * 5 : SR * 7] *= 0.01
    s = A.analyse(y)
    assert s.gated_seconds == pytest.approx(8.0, abs=0.6)
    shape = (s.bands - s.bands[17]) - (loud.bands - loud.bands[17])
    assert np.max(np.abs(shape[7:29])) < 0.5


def test_streaming_in_odd_chunks_gives_the_same_result():
    x = shaped_noise(BALANCED, seconds=6)
    whole = A.analyse(x)
    acc = A.SpectrumAccumulator()
    flat = x.reshape(-1)
    for a, b in [(0, 1000), (1000, 77778), (77778, 300002), (300002, flat.size)]:
        acc.feed(flat[a:b])
    acc.finish()
    part = acc.result()
    assert part.gated_frames == whole.gated_frames
    assert np.allclose(part.power, whole.power)


def test_digital_silence_is_silent():
    assert A.analyse(np.zeros((SR * 3, 2), dtype=np.float32)).silent


def test_cache_form_round_trips():
    s = A.analyse(shaped_noise(BALANCED, seconds=4))
    back = A.spectrum_from_json(A.spectrum_to_json(s))
    assert back.gated_frames == s.gated_frames
    assert np.max(np.abs(back.bands - s.bands)) < 0.01


def test_pink_noise_against_a_flat_target_needs_nothing():
    _s, bands, before, _after = fit_of(shaped_noise(FLAT), FLAT)
    assert bands == []
    assert before < 0.5


def test_noise_shaped_like_balanced_needs_nothing():
    _s, bands, before, _after = fit_of(shaped_noise(BALANCED), BALANCED, F.FREE)
    assert bands == []
    assert before < 0.5


@pytest.mark.parametrize("target", [FLAT, BALANCED])
def test_a_bump_at_250_hz_comes_back_as_a_cut_there(target):
    x = shaped_noise(target, extra=[BUMP_250])
    _s, bands, before, after = fit_of(x, target, tolerance=0.0)
    cuts = [b for b in bands if b.type == BELL and 160 <= b.f <= 400]
    assert cuts, bands
    assert -6.0 <= min(b.g for b in cuts) <= -4.0
    assert after < before / 2
    _s, bands, before, after = fit_of(x, target)
    cuts = [b for b in bands if b.type == BELL and 160 <= b.f <= 400]
    assert cuts and -6.0 <= min(b.g for b in cuts) <= -2.5
    assert after < before


def test_a_dark_signal_gets_a_high_boost():
    x = shaped_noise(BALANCED, extra=[DARK])
    _s, bands, before, after = fit_of(x, BALANCED, F.FREE, max_bands=SUGGEST_MAX_BANDS_LANE)
    high = [b for b in bands if b.f >= 2000 and b.type in (HIGHSHELF, BELL)]
    assert high and all(b.g > 0 for b in high)
    assert after < before - 0.5


@pytest.mark.parametrize(
    ("target", "extra"),
    [
        (FLAT, [BUMP_250]),
        (BALANCED, [Band(HIGHSHELF, 5000.0, 5.0, 0.707, 12), Band(BELL, 300.0, 4.0, 1.4, 12)]),
        (BALANCED, [Band(LOWSHELF, 100.0, 6.0, 0.707, 12)]),
        (BALANCED, [Band(BELL, 2500.0, -6.0, 0.7, 12)]),
    ],
)
def test_the_fit_lowers_the_distance_to_the_target(target, extra):
    s, bands, before, after = fit_of(shaped_noise(target, extra=extra), target)
    assert after <= before + 1e-9
    w = F.weights_for(s.bands)
    if F.outside_rms_db(np.asarray(target) - s.bands, w) > 1.0:
        assert bands and after < before


def test_suggesting_on_a_suggested_result_changes_little():
    s = A.analyse(shaped_noise(BALANCED, extra=MUD_AND_DARK))
    first = F.fit_eq(s.bands, BALANCED, F.FREE, SUGGEST_MAX_BANDS_LANE)
    bands = [fb.band for fb in first.bands]
    assert bands
    after = A.band_levels_after(s.power, bands, F.neutral_out_db(s.power, bands))
    again = F.fit_eq(after, BALANCED, F.FREE, SUGGEST_MAX_BANDS_LANE)
    assert len(again.bands) <= 1
    assert all(abs(fb.band.g) <= 1.5 for fb in again.bands if fb.band.type != LOWCUT)


def _random_spectrum(rng) -> np.ndarray:
    pts = rng.normal(0, 6, 8)
    shape = np.interp(np.arange(A.N_BANDS), np.linspace(0, A.N_BANDS - 1, 8), pts)
    return shape + np.asarray(BALANCED)


def _assert_fixed_panel(fit, slots) -> None:
    ids = [fb.slot for fb in fit.bands]
    assert len(ids) == len(set(ids)), "a knob used twice"
    bells = [(list(slots).index(fb.slot), fb.band.f) for fb in fit.bands if fb.band.type == BELL]
    assert [f for _i, f in sorted(bells)] == sorted(f for _i, f in bells), "bells out of order"


@pytest.mark.parametrize("layout", [F.FREE, *F.FIXED_LAYOUTS])
def test_bounds_are_respected(layout):
    rng = np.random.default_rng(7)
    slots = {s.id: s for s in F.LAYOUTS[layout]}
    max_bands = SUGGEST_MAX_BANDS_LANE
    target = get_target(
        f"{layout}.balanced" if layout in ("bass", "guitar", "keys") else "mix.balanced"
    )
    for _ in range(25):
        fit = F.fit_eq(_random_spectrum(rng), target.bands_db, layout, max_bands)
        assert len(fit.bands) <= max_bands
        curve = np.zeros(A.N_BANDS)
        for fb in fit.bands:
            b, slot = fb.band, slots[fb.slot]
            assert b.type == slot.type and b.q in slot.qs
            assert abs(b.g) <= SUGGEST_GAIN_MAX_DB
            assert b.type == LOWCUT or abs(b.g) >= SUGGEST_MIN_GAIN_DB
            assert slot.dynamic_shelf or b.f in slot.freqs
            curve += A.band_response_db(b)
        assert np.max(np.abs(curve[3:])) <= SUGGEST_COMBINED_MAX_DB + 1e-9
        if layout in F.FIXED_LAYOUTS:
            _assert_fixed_panel(fit, slots)


def test_the_bass_shelf_corner_moves_with_its_gain_like_the_panel():
    assert F.dynamic_shelf_freq(2) == 75
    assert F.dynamic_shelf_freq(-15) == 400
    assert F.dynamic_shelf_freq(9) == pytest.approx(75 * (400 / 75) ** 0.5, abs=0.1)


# The hard rule: a band far under the target is missing content, never boosted.
@pytest.mark.parametrize(
    ("missing", "drop_db", "region"),
    [
        (slice(0, 6), 60, (0, 100)),
        (slice(28, 31), 60, (8000, 20001)),
        (slice(11, 16), 30, (240, 640)),
    ],
    ids=["no-low-end", "encoder-cutoff", "audible-hole"],
)
def test_no_boost_where_content_is_missing(missing, drop_db, region):
    levels = np.asarray(BALANCED).copy()
    levels[missing] -= drop_db
    fit = F.fit_eq(levels, BALANCED, F.FREE, SUGGEST_MAX_BANDS_LANE)
    lo, hi = region
    assert not [fb for fb in fit.bands if lo <= fb.band.f < hi and fb.band.g > 0], fit.bands


def test_boosts_fade_out_between_the_deficit_limits():
    levels = np.asarray(BALANCED).copy()
    levels[12:15] -= 40
    allowed = F.boost_allowed(levels, BALANCED)
    assert allowed[13] == 0.0
    assert allowed[17] == 1.0


def test_reasons_follow_the_numbers():
    s = A.analyse(shaped_noise(FLAT, extra=[BUMP_250]))
    why = band_reasons(F.fit_eq(s.bands, FLAT, F.FREE))
    cut = next(w for w in why if w["key"] == "suggest.why.bellCut")
    assert cut["vars"]["region"] == "lowmid"
    assert cut["vars"]["dev"] > 2.5
    assert cut["vars"]["g"] < 0


def _ffmpeg_render(src, dst, chain):
    subprocess.run(
        [ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-y", "-i", str(src),
         "-af", chain, "-c:a", "pcm_f32le", str(dst)],
        check=True,
        timeout=120,
    )  # fmt: skip


@pytest.mark.parametrize(
    ("extra", "target"),
    [
        ([BUMP_250], FLAT),
        ([DARK], BALANCED),
        ([Band(LOWSHELF, 120.0, 6.0, 0.707, 12), Band(BELL, 3000.0, -5.0, 1.0, 12)], BALANCED),
    ],
)
def test_the_suggested_eq_keeps_the_loudness(tmp_path, extra, target):
    skip_without_ffmpeg()
    meter = pyln.Meter(SR)
    x = shaped_noise(target, extra=extra, seconds=8)
    src, dst = tmp_path / "in.wav", tmp_path / "out.wav"
    sf.write(src, x, SR, subtype="FLOAT")
    s = A.analyse(x)
    bands = [fb.band for fb in F.fit_eq(s.bands, target, F.FREE, SUGGEST_MAX_BANDS_LANE).bands]
    assert bands
    _ffmpeg_render(src, dst, eq_filter(Eq(F.neutral_out_db(s.power, bands), tuple(bands)), SR))
    y, _ = sf.read(dst, dtype="float64")
    change = meter.integrated_loudness(y) - meter.integrated_loudness(x.astype(np.float64))
    assert abs(change) < 0.5


def _suggest(spec, mode, current=None):
    target = get_target("mix.balanced")
    return make_suggestion(spec, target, F.FREE, mode, current, SUGGEST_MAX_BANDS_LANE, [])


def test_merge_keeps_the_current_bands_and_adds_new_ones():
    s = A.analyse(shaped_noise(BALANCED, extra=MUD_AND_DARK))
    current = Eq(1.5, (Band(BELL, 300.0, -5.0, 1.0, 12),))
    merged = _suggest(s, MERGE, current)
    first = {k: merged["bands"][0][k] for k in ("type", "f", "g", "q", "slope")}
    assert first == {"type": BELL, "f": 300.0, "g": -5.0, "q": 1.0, "slope": 12}
    added = merged["bands"][1:]
    assert added and all(b["f"] >= 2000 for b in added)
    replaced = _suggest(s, REPLACE, current)
    assert any(160 <= b["f"] <= 400 and b["g"] < 0 for b in replaced["bands"])
    assert abs(replaced["loudness"]) < 0.15 and abs(merged["loudness"]) < 0.15


def test_the_answer_has_the_contract_shape():
    ans = _suggest(A.analyse(shaped_noise(BALANCED, extra=MUD_AND_DARK)), REPLACE)
    assert set(ans) == {"bands", "out", "reasons", "loudness", "target", "targets"}
    assert ans["target"] == "mix.balanced"
    assert all(r["key"].startswith("suggest.why.") for r in ans["reasons"])


@pytest.mark.parametrize(
    ("gain_db", "seconds"),
    [(-45.0, 10.0), (0.0, 2.0)],
    ids=["below-the-loudness-floor", "too-little-gated-audio"],
)
def test_not_enough_signal_is_refused(gain_db, seconds):
    x = shaped_noise(FLAT, seconds=seconds) * 10 ** (gain_db / 20)
    with pytest.raises(NotEnoughSignal):
        make_suggestion(A.analyse(x), get_target("other.balanced"), F.FREE, REPLACE, None, 5, [])


def test_targets_are_complete():
    for t in load_targets().values():
        assert len(t.bands_db) == A.N_BANDS and all(np.isfinite(t.bands_db))
        assert t.label_key.startswith("suggest.target.")
        assert t.id == f"{t.use}.{t.variant}"
        assert t.target_lufs == (-14 if t.use == "mix" else None)


def test_every_lane_with_a_panel_has_targets():
    for lane in ("bass", "drums", "guitar", "piano", "other", "original"):
        assert default_target(lane) is not None
    assert default_target("vocals") is None


def test_balanced_is_darker_than_pink_above_1_khz():
    b = np.asarray(BALANCED)
    assert b[17] - b[27] > 10
    assert abs(b[11] - b[15]) < 1.5
