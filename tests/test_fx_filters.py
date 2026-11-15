"""The export EQ maths (app/pipeline/fx_filters.py) against the live engine.

tests/fixtures/eq_golden.json holds, for every band type, both cut slopes,
high and low frequencies and a full cascade, the response Chromium's own
BiquadFilterNodes report at 44.1 and 48 kHz (taken from upstream b5f48e1; the
future static/js/eqMath.js reads the same file). The Python coefficients are
held to that independent reference, and an ffmpeg render of an impulse through
the export's filter string is held to the Python maths, so the three cannot
drift apart.

Then the fx= parser: every malformed or hostile value is an FxError carrying
one of the contract's 422 messages, and nothing but numbers this module
formats reaches the filter graph.
"""

from __future__ import annotations

import base64
import json
import math
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from app.core.config import (
    FX_MAX_BANDS,
    FX_MAX_LANES,
    FX_MAX_SECTIONS,
    FX_PARAM_MAX_CHARS,
    ffmpeg_executable,
)
from app.pipeline.fx_filters import (
    Band,
    Eq,
    FxError,
    Section,
    band_sections,
    butterworth_qs,
    check_section_budget,
    eq_filter,
    eq_response_db,
    parse_fx_param,
    section_coefficients,
    slot_filter,
    slot_section_count,
)
from tests.ffmpeg_probe import skip_without_ffmpeg

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "eq_golden.json").read_text("utf-8"))
GOLDEN_TOLERANCE_DB = 1e-3
FFMPEG_TOLERANCE_DB = 1e-5


def _eq(raw: dict) -> Eq:
    """A golden case (eqMath descriptor) as the server parses it."""
    bands = tuple(
        Band(b["type"], round(b["f"], 1), round(b["g"], 2), round(b["q"], 3), b["slope"])
        for b in raw["params"]["bands"]
    )
    return Eq(round(raw["params"]["out"], 2), bands)


def _wire(body: object) -> str:
    return base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip("=")


def _lane(effect: dict) -> str:
    return _wire({"v": 1, "lanes": {"bass": [effect]}})


def _band(band: list) -> str:
    return _lane({"id": "eq", "b": [band]})


# ─── Maths ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rate", GOLDEN["rates"])
@pytest.mark.parametrize("case", sorted(GOLDEN["cases"]))
def test_python_response_matches_chromium(rate, case):
    ours = eq_response_db(_eq(GOLDEN["cases"][case]), GOLDEN["freqs"], rate)
    theirs = GOLDEN["chromium"][str(rate)][case]
    worst = max(abs(a - b) for a, b in zip(ours, theirs, strict=True))
    assert worst < GOLDEN_TOLERANCE_DB, f"{case} at {rate}: {worst:.2e} dB"


def test_peaking_coefficients_by_the_spec():
    b0, b1, b2, a1, a2 = section_coefficients(Section("peaking", 1000, 1, 12), 48000)
    a = 10 ** (12 / 40)
    w0 = 2 * math.pi * 1000 / 48000
    alpha = math.sin(w0) / 2
    a0 = 1 + alpha / a
    assert b0 == pytest.approx((1 + alpha * a) / a0, rel=1e-15)
    assert b1 == pytest.approx(-2 * math.cos(w0) / a0, rel=1e-15)
    assert b2 == pytest.approx((1 - alpha * a) / a0, rel=1e-15)
    assert a1 == b1
    assert a2 == pytest.approx((1 - alpha / a) / a0, rel=1e-15)


def test_butterworth_section_qs():
    assert butterworth_qs(2) == pytest.approx([math.sqrt(0.5)])
    assert butterworth_qs(4) == pytest.approx([0.5411961, 1.3065630])
    assert butterworth_qs(8) == pytest.approx([0.5097956, 0.6013449, 0.8999762, 2.5629154])


def test_cut_sections_and_resonance():
    flat = band_sections(Band("lowcut", 100, 0, 0.707, 24))
    assert [s.type for s in flat] == ["highpass", "highpass"]
    assert [s.q for s in flat] == pytest.approx(butterworth_qs(4))
    peaky = band_sections(Band("highcut", 100, 0, 1.414, 24))
    assert [s.type for s in peaky] == ["lowpass", "lowpass"]
    assert peaky[1].q == pytest.approx(butterworth_qs(4)[1] * 2)
    for slope in (12, 24, 36, 48):
        db = eq_response_db(Eq(0, (Band("lowcut", 1000, 0, 0.707, slope),)), [1000], 44100)[0]
        assert db == pytest.approx(-3.01, abs=0.02)


def test_tilt_is_two_opposite_shelves():
    s = band_sections(Band("tilt", 1000, 6, 1, 12))
    assert [(x.type, x.g) for x in s] == [("lowshelf", -3), ("highshelf", 3)]
    lo, hi = eq_response_db(Eq(0, (Band("tilt", 1000, 6, 1, 12),)), [20, 20000], 44100)
    assert lo == pytest.approx(-3, abs=0.05)
    assert hi == pytest.approx(3, abs=0.1)


# ─── Filter strings ──────────────────────────────────────────────────────


def test_neutral_bands_and_flat_eq_add_nothing():
    neutral = (
        Band("bell", 1000, 0, 1, 12),
        Band("lowshelf", 100, 0, 0.707, 12),
        Band("highshelf", 8000, 0, 0.707, 12),
        Band("tilt", 500, 0, 1, 12),
    )
    flat = Eq(0, neutral)
    assert eq_filter(flat, 44100) == ""
    assert slot_filter([flat], 44100) == ""
    assert slot_filter([], 44100) == ""
    assert slot_section_count([flat]) == 0


def test_output_gain_alone_is_a_volume_filter():
    assert eq_filter(Eq(-6, ()), 44100) == f"volume={10 ** (-6 / 20)!r}"


def test_section_filter_carries_the_exact_doubles():
    eq = Eq(0, (Band("bell", 1000, 12, 1, 12),))
    b0, b1, b2, a1, a2 = section_coefficients(Section("peaking", 1000, 1, 12), 44100)
    assert eq_filter(eq, 44100) == (
        f"biquad=b0={b0!r}:b1={b1!r}:b2={b2!r}:a0=1.0:a1={a1!r}:a2={a2!r}:r=f64"
    )


def test_filter_string_is_numbers_only():
    text = eq_filter(_eq(GOLDEN["cases"]["cascade"]), 44100)
    for part in text.split(","):
        name, _, args = part.partition("=")
        assert name in ("biquad", "volume")
        if name == "volume":
            float(args)
            continue
        for kv in args.split(":"):
            key, _, value = kv.partition("=")
            assert value == "f64" if key == "r" else float(value) == float(value)


# ─── ffmpeg runs exactly these coefficients ──────────────────────────────


def _ffmpeg_impulse(
    tmp_path: Path, chain: str, rate: int, seconds: float = 1.0, subtype: str = "DOUBLE"
) -> np.ndarray:
    x = np.zeros(int(rate * seconds))
    x[0] = 0.5
    src = tmp_path / "imp.wav"
    dst = tmp_path / "out.wav"
    sf.write(src, x, rate, subtype=subtype)
    cmd = [ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-y", "-i", str(src)]
    cmd += ["-af", chain, "-c:a", "pcm_f64le", str(dst)]
    subprocess.run(cmd, check=True, timeout=60)
    return sf.read(dst, dtype="float64")[0]


@pytest.mark.parametrize("rate", GOLDEN["rates"])
@pytest.mark.parametrize("case", sorted(GOLDEN["cases"]))
def test_ffmpeg_render_matches_the_maths(tmp_path, rate, case):
    skip_without_ffmpeg()
    eq = _eq(GOLDEN["cases"][case])
    h = 2 * _ffmpeg_impulse(tmp_path, eq_filter(eq, rate), rate)
    spec = np.fft.rfft(h)
    freqs = np.unique(np.round(np.geomspace(20, 20000, 150)).astype(int))
    measured = 20 * np.log10(np.abs(spec[(freqs * len(h)) // rate]))
    expected = np.array(eq_response_db(eq, [float(f) for f in freqs], rate))
    worst = float(np.max(np.abs(measured - expected)))
    assert worst < FFMPEG_TOLERANCE_DB, f"{case} at {rate}: {worst:.2e} dB"


def test_ffmpeg_filters_a_16_bit_stem_in_double_precision(tmp_path):
    skip_without_ffmpeg()
    eq = Eq(0, (Band("bell", 1000, 6, 1, 12),))
    h = _ffmpeg_impulse(tmp_path, eq_filter(eq, 44100), 44100, seconds=0.1, subtype="PCM_16")
    steps = h[:2000] * 32768
    assert np.any(np.abs(steps - np.round(steps)) > 1e-3)


# ─── Parsing fx= ─────────────────────────────────────────────────────────


def test_parse_valid_and_empty():
    assert parse_fx_param("").lanes == {}
    assert parse_fx_param(None).master == []
    req = parse_fx_param(
        _wire(
            {
                "v": 1,
                "lanes": {"bass": [{"id": "eq", "out": -1.5, "b": [["lowcut", 40, 0, 0.707, 24]]}]},
                "master": [{"id": "eq", "out": 0, "b": [["bell", 3000, -2, 1.2, 12]]}],
            }
        )
    )
    assert req.lanes["bass"][0] == Eq(-1.5, (Band("lowcut", 40.0, 0.0, 0.707, 24),))
    assert req.master[0].bands[0].type == "bell"


TWELVE_BELLS = [["bell", 100, 1, 1, 12]] * FX_MAX_BANDS
BAD = [
    ("not base64", "!!!!", "fx: malformed"),
    ("path", "../../etc/passwd", "fx: malformed"),
    ("padding", _wire({"v": 1}) + "==", "fx: malformed"),
    ("not json", _wire("x")[:-2] + "@@", "fx: malformed"),
    ("not utf-8", base64.urlsafe_b64encode(b"\xff\xfe").decode().rstrip("="), "fx: malformed"),
    ("json but list", _wire([1, 2]), "fx: malformed"),
    ("extra key", _wire({"v": 1, "lanes": {}, "cmd": "rm"}), "fx: malformed"),
    ("lanes not a dict", _wire({"v": 1, "lanes": ["bass"]}), "fx: malformed"),
    ("too long", "A" * (FX_PARAM_MAX_CHARS + 1), "fx: malformed"),
    ("no version", _wire({"lanes": {}}), "fx: unsupported version"),
    ("future version", _wire({"v": 2, "lanes": {}}), "fx: unsupported version"),
    ("bool version", _wire({"v": True, "lanes": {}}), "fx: unsupported version"),
    ("lane with filter syntax", _wire({"v": 1, "lanes": {"bass[a]": []}}), "fx: unknown lane"),
    ("lane upper case", _wire({"v": 1, "lanes": {"BASS": []}}), "fx: unknown lane"),
    (
        "too many lanes",
        _wire({"v": 1, "lanes": {f"l{i}": [] for i in range(FX_MAX_LANES + 1)}}),
        "fx: lanes out of range",
    ),
    ("slot not a list", _wire({"v": 1, "lanes": {"bass": {"id": "eq"}}}), "fx: malformed"),
    ("effect not eq", _lane({"id": "afir"}), "fx: malformed"),
    ("two eqs", _wire({"v": 1, "lanes": {"bass": [{"id": "eq"}, {"id": "eq"}]}}), "fx: malformed"),
    ("effect extra field", _lane({"id": "eq", "f": "x"}), "fx: malformed"),
    ("string number", _lane({"id": "eq", "out": "3"}), "fx: malformed"),
    ("bool number", _lane({"id": "eq", "out": True}), "fx: malformed"),
    ("out too big", _lane({"id": "eq", "out": 99}), "fx: output gain out of range"),
    ("bands not a list", _lane({"id": "eq", "b": "x"}), "fx: malformed"),
    (
        "13 bands",
        _lane({"id": "eq", "b": [*TWELVE_BELLS, TWELVE_BELLS[0]]}),
        "fx: bands out of range",
    ),
    ("short band", _band(["bell", 100]), "fx: malformed"),
    ("type injection", _band(["bell,anull", 1e3, 1, 1, 12]), "fx: malformed"),
    ("frequency above", _band(["bell", 30000, 1, 1, 12]), "fx: frequency out of range"),
    ("frequency below", _band(["bell", 5, 1, 1, 12]), "fx: frequency out of range"),
    ("gain too big", _band(["bell", 100, 31, 1, 12]), "fx: gain out of range"),
    ("q zero", _band(["bell", 100, 1, 0, 12]), "fx: q out of range"),
    ("q too big", _band(["bell", 100, 1, 41, 12]), "fx: q out of range"),
    ("odd slope", _band(["lowcut", 100, 0, 1, 18]), "fx: slope out of range"),
    ("float slope", _band(["lowcut", 100, 0, 1, 12.0]), "fx: malformed"),
]


@pytest.mark.parametrize(("label", "raw", "message"), BAD, ids=[b[0] for b in BAD])
def test_parse_rejects_with_the_contract_message(label, raw, message):
    with pytest.raises(FxError) as err:
        parse_fx_param(raw)
    assert str(err.value) == message


def test_twelve_bands_are_accepted():
    req = parse_fx_param(_lane({"id": "eq", "b": TWELVE_BELLS}))
    assert len(req.lanes["bass"][0].bands) == FX_MAX_BANDS


@pytest.mark.parametrize("constant", ["NaN", "Infinity", "-Infinity"])
def test_parse_rejects_non_finite(constant):
    text = '{"v": 1, "lanes": {"bass": [{"id": "eq", "out": ' + constant + "}]}}"
    raw = base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")
    with pytest.raises(FxError, match="^fx: malformed$"):
        parse_fx_param(raw)


def test_parse_rejects_deep_nesting_without_crashing():
    text = "[" * 5000 + "]" * 5000
    raw = base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")[:FX_PARAM_MAX_CHARS]
    with pytest.raises(FxError, match="^fx: malformed$"):
        parse_fx_param(raw)


def test_section_budget():
    check_section_budget(FX_MAX_SECTIONS)
    with pytest.raises(FxError, match="^fx: too many EQ bands for one export$"):
        check_section_budget(FX_MAX_SECTIONS + 1)
