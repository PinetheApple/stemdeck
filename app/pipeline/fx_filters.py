"""Export side of the studio EQ: the same biquad coefficients as the live engine.

The live EQ runs in the browser as native BiquadFilterNodes. Their
coefficients are fixed by the Web Audio spec's "Filters Characteristics": the
RBJ Audio EQ Cookbook, with Q in dB for lowpass/highpass, linear Q for
peaking/notch/bandpass, and the shelf slope fixed at S = 1 (the node ignores Q
for shelves). This module computes exactly those coefficients, at the stem's
own sample rate, and hands them to ffmpeg's ``biquad`` filter as the shortest
decimal that reads back as the same double, so an export runs the filter the
user heard. The bilinear transform keeps f0, gain and Q exact at any rate; a
44.1 kHz export and a 48 kHz device differ only by frequency warping near
Nyquist. That makes it the same filter design, not the same samples.

Band types map to sections as follows: a bell is one peaking section, a shelf
one shelf, a tilt a low shelf at -g/2 plus a high shelf at +g/2, and a cut of
slope 12·n dB/oct is n cascaded Butterworth sections whose last (most
resonant) Q scales with the band's Q. A band that changes nothing (a 0 dB
bell, shelf or tilt) builds no section, so a flat EQ leaves the export graph,
and its cache key, byte-identical to an export without one.

The ``fx=`` export parameter is parsed here (``parse_fx_param``): base64url
JSON, size-capped, every field typed and range-checked. Every refusal is an
``FxError`` whose message is safe to show as a 422, and nothing but numbers
this module formats ever reaches the filter graph. The wire readers
(``decode_wire_object``, ``check_wire_version``, ``read_wire_number``) and
the dB helpers are shared with app/pipeline/mastering.py. Pure, no I/O.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import partial

from app.core.config import FX_MAX_BANDS, FX_MAX_LANES, FX_MAX_SECTIONS, FX_PARAM_MAX_CHARS

EQ_ID = "eq"
FX_WIRE_VERSION = 1

BELL = "bell"
LOWSHELF = "lowshelf"
HIGHSHELF = "highshelf"
LOWCUT = "lowcut"
HIGHCUT = "highcut"
NOTCH = "notch"
BANDPASS = "bandpass"
TILT = "tilt"
# Web Audio node types; shelves, notch and bandpass share the band names.
PEAKING = "peaking"
LOWPASS = "lowpass"
HIGHPASS = "highpass"

EQ_TYPES = (BELL, LOWSHELF, HIGHSHELF, LOWCUT, HIGHCUT, NOTCH, BANDPASS, TILT)
EQ_SLOPES = (12, 24, 36, 48)
FREQ_MIN, FREQ_MAX = 10.0, 20000.0
GAIN_MIN, GAIN_MAX = -30.0, 30.0
Q_MIN, Q_MAX = 0.025, 40.0
OUT_MIN, OUT_MAX = -24.0, 24.0
# q = 0.707 gives exactly the Butterworth section Qs: a cut's "no resonance".
DEFAULT_Q = 0.707
DB_PER_ORDER = 6
SHELF_SLOPE_ALPHA = math.sqrt(2.0)

WIRE_MALFORMED = "malformed"
WIRE_UNSUPPORTED_VERSION = "unsupported version"
FX_PREFIX = "fx"
FX_MALFORMED = f"{FX_PREFIX}: {WIRE_MALFORMED}"
FX_UNKNOWN_LANE = f"{FX_PREFIX}: unknown lane"
FX_TOO_MANY_SECTIONS = f"{FX_PREFIX}: too many EQ bands for one export"

_GAIN_BANDS = (BELL, LOWSHELF, HIGHSHELF, TILT)
_CUTS = (LOWCUT, HIGHCUT)
_SHELVES = (LOWSHELF, HIGHSHELF)
_PASSES = (LOWPASS, HIGHPASS)
_FX_KEYS = frozenset({"v", "lanes", "master"})
_EFFECT_KEYS = frozenset({"id", "out", "b"})
_BAND_FIELDS = 5
_B64URL_RE = re.compile(r"^[A-Za-z0-9_-]*$")
_LANE_KEY_RE = re.compile(r"^[a-z0-9_]{1,32}$")

Coefficients = tuple[float, float, float, float, float]


class FxError(ValueError):
    """A malformed or out-of-range ``fx`` value. The message is safe to show."""


@dataclass(frozen=True)
class Band:
    type: str
    f: float
    g: float
    q: float
    slope: int


@dataclass(frozen=True)
class Eq:
    out: float
    bands: tuple[Band, ...]


@dataclass(frozen=True)
class Section:
    """One Web Audio BiquadFilterNode: its type, frequency, LINEAR Q, gain."""

    type: str
    f: float
    q: float
    g: float


@dataclass
class FxRequest:
    lanes: dict[str, list[Eq]] = field(default_factory=dict)
    master: list[Eq] = field(default_factory=list)


def db_to_linear(db: float) -> float:
    return 10.0 ** (db / 20.0)


def linear_to_db(value: float) -> float:
    return 20.0 * math.log10(value)


def band_is_neutral(band: Band) -> bool:
    return band.type in _GAIN_BANDS and band.g == 0


def butterworth_qs(order: int) -> list[float]:
    """Section Qs of an even-order Butterworth filter, lowest first."""
    return sorted(
        1.0 / (2.0 * math.cos((2 * k - 1) * math.pi / (2 * order)))
        for k in range(1, order // 2 + 1)
    )


def _cut_sections(band: Band) -> list[Section]:
    node = HIGHPASS if band.type == LOWCUT else LOWPASS
    qs = butterworth_qs(band.slope // DB_PER_ORDER)
    qs[-1] *= band.q / DEFAULT_Q
    return [Section(node, band.f, q, 0.0) for q in qs]


def band_sections(band: Band) -> list[Section]:
    if band_is_neutral(band):
        return []
    t, f, g, q = band.type, band.f, band.g, band.q
    if t in _CUTS:
        return _cut_sections(band)
    if t == TILT:
        return [Section(LOWSHELF, f, 0.0, -g / 2), Section(HIGHSHELF, f, 0.0, g / 2)]
    if t in _SHELVES:
        return [Section(t, f, 0.0, g)]
    if t == BELL:
        return [Section(PEAKING, f, q, g)]
    return [Section(t, f, q, 0.0)]


def eq_sections(eq: Eq) -> list[Section]:
    return [s for band in eq.bands for s in band_sections(band)]


def _node_q(section: Section) -> float:
    """BiquadFilterNode.Q for the section: dB for lowpass/highpass."""
    if section.type in _PASSES:
        return linear_to_db(section.q)
    return section.q


def _angles(section: Section, fs: float) -> tuple[float, float, float]:
    """cos w0, sin w0 and the spec's A, the square root of the linear gain."""
    w0 = 2.0 * math.pi * min(max(section.f, 0.0), fs / 2) / fs
    return math.cos(w0), math.sin(w0), db_to_linear(section.g / 2)


def _normalise(b: tuple[float, float, float], a: tuple[float, float, float]) -> Coefficients:
    return (b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0])


def _pass(section: Section, fs: float) -> Coefficients:
    cw, sw, _ = _angles(section, fs)
    # The node takes Q in dB; going through dB matches what the browser computes.
    alpha = sw / (2.0 * db_to_linear(_node_q(section)))
    sign = -1.0 if section.type == LOWPASS else 1.0
    edge = (1 + sign * cw) / 2
    return _normalise((edge, -sign * 2 * edge, edge), (1 + alpha, -2 * cw, 1 - alpha))


def _bandpass(section: Section, fs: float) -> Coefficients:
    cw, sw, _ = _angles(section, fs)
    alpha = sw / (2.0 * section.q)
    return _normalise((alpha, 0.0, -alpha), (1 + alpha, -2 * cw, 1 - alpha))


def _notch(section: Section, fs: float) -> Coefficients:
    cw, sw, _ = _angles(section, fs)
    alpha = sw / (2.0 * section.q)
    return _normalise((1.0, -2 * cw, 1.0), (1 + alpha, -2 * cw, 1 - alpha))


def _peaking(section: Section, fs: float) -> Coefficients:
    cw, sw, a = _angles(section, fs)
    alpha = sw / (2.0 * section.q)
    b = (1 + alpha * a, -2 * cw, 1 - alpha * a)
    return _normalise(b, (1 + alpha / a, -2 * cw, 1 - alpha / a))


def _lowshelf(section: Section, fs: float) -> Coefficients:
    cw, sw, a = _angles(section, fs)
    k = sw * SHELF_SLOPE_ALPHA * math.sqrt(a)
    b0 = a * ((a + 1) - (a - 1) * cw + k)
    b1 = 2 * a * ((a - 1) - (a + 1) * cw)
    b2 = a * ((a + 1) - (a - 1) * cw - k)
    a0 = (a + 1) + (a - 1) * cw + k
    a1 = -2 * ((a - 1) + (a + 1) * cw)
    a2 = (a + 1) + (a - 1) * cw - k
    return _normalise((b0, b1, b2), (a0, a1, a2))


def _highshelf(section: Section, fs: float) -> Coefficients:
    cw, sw, a = _angles(section, fs)
    k = sw * SHELF_SLOPE_ALPHA * math.sqrt(a)
    b0 = a * ((a + 1) + (a - 1) * cw + k)
    b1 = -2 * a * ((a - 1) + (a + 1) * cw)
    b2 = a * ((a + 1) + (a - 1) * cw - k)
    a0 = (a + 1) - (a - 1) * cw + k
    a1 = 2 * ((a - 1) - (a + 1) * cw)
    a2 = (a + 1) - (a - 1) * cw - k
    return _normalise((b0, b1, b2), (a0, a1, a2))


_DESIGNS: dict[str, Callable[[Section, float], Coefficients]] = {
    LOWPASS: _pass,
    HIGHPASS: _pass,
    BANDPASS: _bandpass,
    NOTCH: _notch,
    PEAKING: _peaking,
    LOWSHELF: _lowshelf,
    HIGHSHELF: _highshelf,
}


def section_coefficients(section: Section, fs: float) -> Coefficients:
    """(b0, b1, b2, a1, a2) of the section at sample rate ``fs``, a0 = 1."""
    return _DESIGNS[section.type](section, fs)


def _mag_db(c: Coefficients, f: float, fs: float) -> float:
    b0, b1, b2, a1, a2 = c
    z = complex(math.cos(2.0 * math.pi * f / fs), -math.sin(2.0 * math.pi * f / fs))
    return linear_to_db(abs(b0 + b1 * z + b2 * z * z) / abs(1 + a1 * z + a2 * z * z))


def eq_response_db(eq: Eq, freqs: list[float], fs: float) -> list[float]:
    """|H| in dB at each frequency, output gain included."""
    coefs = [section_coefficients(s, fs) for s in eq_sections(eq)]
    return [eq.out + sum(_mag_db(c, f, fs) for c in coefs) for f in freqs]


def _num(v: float) -> str:
    return repr(float(v))


def section_filter(section: Section, fs: float) -> str:
    b0, b1, b2, a1, a2 = section_coefficients(section, fs)
    # r=f64: the default ("auto") filters in the input's format, 16 bits for a 16-bit WAV.
    return (
        f"biquad=b0={_num(b0)}:b1={_num(b1)}:b2={_num(b2)}:a0=1.0:a1={_num(a1)}:a2={_num(a2)}:r=f64"
    )


def eq_filter(eq: Eq, fs: float) -> str:
    """The filter chain for one EQ at ``fs``, "" when it changes nothing."""
    parts = [section_filter(s, fs) for s in eq_sections(eq)]
    if eq.out != 0:
        parts.append(f"volume={_num(db_to_linear(eq.out))}")
    return ",".join(parts)


def slot_filter(effects: list[Eq], fs: float) -> str:
    """All effects of one slot, in order, "" when none changes the sound."""
    return ",".join(p for p in (eq_filter(e, fs) for e in effects) if p)


def slot_section_count(effects: list[Eq]) -> int:
    return sum(len(eq_sections(e)) for e in effects)


def check_section_budget(sections: int) -> None:
    if sections > FX_MAX_SECTIONS:
        raise FxError(FX_TOO_MANY_SECTIONS)


def _reject_constant(_name: str) -> float:
    raise ValueError("non-finite JSON number")


def _decode_json(raw: str, max_chars: int) -> object:
    if len(raw) > max_chars or not _B64URL_RE.match(raw):
        raise ValueError("not unpadded base64url within the size cap")
    try:
        text = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8")
        return json.loads(text, parse_constant=_reject_constant)
    except (binascii.Error, UnicodeDecodeError, RecursionError) as exc:
        raise ValueError(str(exc)) from None


def decode_wire_object(
    raw: str,
    max_chars: int,
    keys: frozenset[str],
    error: type[ValueError],
    prefix: str,
) -> dict:
    """A JSON object from unpadded base64url holding only ``keys``."""
    try:
        body = _decode_json(raw, max_chars)
    except ValueError:
        raise error(f"{prefix}: {WIRE_MALFORMED}") from None
    if not isinstance(body, dict) or set(body) - keys:
        raise error(f"{prefix}: {WIRE_MALFORMED}")
    return body


def check_wire_version(body: dict, expected: int, error: type[ValueError], prefix: str) -> None:
    version = body.get("v")
    if isinstance(version, bool) or version != expected:
        raise error(f"{prefix}: {WIRE_UNSUPPORTED_VERSION}")


def read_wire_number(
    v: object,
    lo: float,
    hi: float,
    what: str,
    error: type[ValueError],
    prefix: str,
) -> float:
    """``v`` as a float in [lo, hi]; malformed if not a JSON number."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise error(f"{prefix}: {WIRE_MALFORMED}")
    x = float(v)
    if not math.isfinite(x) or x < lo or x > hi:
        raise error(f"{prefix}: {what} out of range")
    return x


_number = partial(read_wire_number, error=FxError, prefix=FX_PREFIX)


def _parse_band(raw: object) -> Band:
    if not isinstance(raw, list) or len(raw) != _BAND_FIELDS:
        raise FxError(FX_MALFORMED)
    t, f, g, q, slope = raw
    if not isinstance(t, str) or t not in EQ_TYPES:
        raise FxError(FX_MALFORMED)
    if isinstance(slope, bool) or not isinstance(slope, int):
        raise FxError(FX_MALFORMED)
    if slope not in EQ_SLOPES:
        raise FxError(f"{FX_PREFIX}: slope out of range")
    f = _number(f, FREQ_MIN, FREQ_MAX, "frequency")
    g = _number(g, GAIN_MIN, GAIN_MAX, "gain")
    return Band(t, f, g, _number(q, Q_MIN, Q_MAX, "q"), slope)


def _parse_effect(raw: object) -> Eq:
    if not isinstance(raw, dict) or set(raw) - _EFFECT_KEYS or raw.get("id") != EQ_ID:
        raise FxError(FX_MALFORMED)
    out = _number(raw.get("out", 0), OUT_MIN, OUT_MAX, "output gain")
    bands = raw.get("b", [])
    if not isinstance(bands, list):
        raise FxError(FX_MALFORMED)
    if len(bands) > FX_MAX_BANDS:
        raise FxError(f"{FX_PREFIX}: bands out of range")
    return Eq(out, tuple(_parse_band(b) for b in bands))


def _parse_slot(raw: object) -> list[Eq]:
    # One EQ per slot: a second would be an effect the live chain does not have.
    if not isinstance(raw, list) or len(raw) > 1:
        raise FxError(FX_MALFORMED)
    return [_parse_effect(e) for e in raw]


def _parse_lanes(raw: object) -> dict[str, list[Eq]]:
    if not isinstance(raw, dict):
        raise FxError(FX_MALFORMED)
    if len(raw) > FX_MAX_LANES:
        raise FxError(f"{FX_PREFIX}: lanes out of range")
    if not all(_LANE_KEY_RE.match(name) for name in raw):
        raise FxError(FX_UNKNOWN_LANE)
    return {name: _parse_slot(slot) for name, slot in raw.items()}


def parse_fx_param(raw: str | None) -> FxRequest:
    """Decode and validate ``fx=``. Empty means no effects. Raises FxError."""
    if not raw:
        return FxRequest()
    body = decode_wire_object(raw, FX_PARAM_MAX_CHARS, _FX_KEYS, FxError, FX_PREFIX)
    check_wire_version(body, FX_WIRE_VERSION, FxError, FX_PREFIX)
    lanes = _parse_lanes(body.get("lanes", {}))
    return FxRequest(lanes=lanes, master=_parse_slot(body.get("master", [])))
