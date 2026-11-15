"""Long-term average spectrum (LTAS) of a lane or a mix, loud passages only.

This is what Suggest EQ compares with a target curve (eq_targets.json) and
what the fitter (eq_fit.py) works on. Pure numpy; the audio arrives as 32-bit
float stereo at ANALYSIS_RATE (ffmpeg decodes it, app/api/suggest.py).

Method:

- Frames of FRAME (16384 samples, 371 ms) every HOP (4410 samples, 100 ms),
  Hann window, one real FFT per channel. 16384 points give 2.7 Hz bins, so
  even the 20 Hz third-octave band (17.8 to 22.4 Hz) holds a bin.
- Every frame's loudness is computed BS.1770-style from its spectrum: the
  power of each bin weighted by the K-filter's magnitude (the RBJ high shelf
  +4 dB at 1500 Hz and the high pass at 38 Hz that pyloudnorm uses to
  re-derive BS.1770's 48 kHz filters at other rates), summed over the two
  channels, -0.691 + 10 log10. Parseval makes that the windowed mean square
  of the K-filtered frame, so the number is a loudness in LUFS. It only
  chooses frames; the loudness the UI shows comes from ffmpeg's ebur128.
- Gating, the rule that keeps silence, fades and bleed out: the two gates of
  ITU-R BS.1770, applied to these frames. Absolute: frames under -70 LUFS are
  dropped. Relative: frames more than 10 LU under the energy mean of the
  frames that passed the absolute gate are dropped. What remains is the part
  of the song where the lane actually plays; a guitar that only enters in the
  chorus is measured on the chorus, not on the verses where its stem carries
  a little bleed 20 dB down.
- One pass, constant memory: frames are accumulated into a histogram of
  loudness in GATE_STEP_LU steps (the way libebur128 gates), each bin holding
  the sum of its frames' power spectra. After the last frame the relative
  threshold is known and the bins above it are summed. The result is the
  mean power spectrum of the loud frames at FFT resolution, so any EQ can be
  applied to it exactly afterwards (eq_fit.py).
- Third-octave bands: the 31 ISO 266 bands from 20 Hz to 20 kHz, exact
  centres 1000 * 2^(n/3), edges a sixth of an octave either side; a band's
  level is the summed power of the bins inside it. Pink noise (equal power
  per octave) reads flat in these bands.
- A spectrum through an EQ (``apply_eq``, ``loudness_change_db``) uses the
  engine's own biquad sections (fx_filters.py), exactly, at ANALYSIS_RATE.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.pipeline.fx_filters import (
    HIGHPASS,
    HIGHSHELF,
    Band,
    Coefficients,
    Section,
    band_sections,
    db_to_linear,
    section_coefficients,
)

ANALYSIS_RATE = 44100
CHANNELS = 2
FRAME = 16384
HOP = 4410
GATE_ABS_LUFS = -70.0
GATE_REL_LU = -10.0
GATE_STEP_LU = 0.25
LUFS_OFFSET = -0.691
_GATE_TOP_LUFS = 10.0
_GATE_BINS = int((_GATE_TOP_LUFS - GATE_ABS_LUFS) / GATE_STEP_LU)
_BINS = FRAME // 2 + 1
# A trailing partial frame at least this long is analysed, zero padded.
_TAIL_MIN = FRAME // 4

# ISO 266 nominal centre frequencies, 20 Hz to 20 kHz (labels for people).
NOMINAL_HZ = (
    20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
    1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
)  # fmt: skip
N_BANDS = len(NOMINAL_HZ)
_REF_HZ = 1000.0
_FIRST_BAND, _LAST_BAND = -17, 13
CENTRES_HZ = tuple(_REF_HZ * 2.0 ** (n / 3.0) for n in range(_FIRST_BAND, _LAST_BAND + 1))
_EDGE = 2.0 ** (1.0 / 6.0)
TINY = 1e-30
_CACHE_DECIMALS = 3
_CACHE_FLOOR_DB = -299.0

_POWER_DB = 10.0
# BS.1770's K-filter, re-derived so that it holds at any rate.
_K_SHELF = Section(HIGHSHELF, 1681.974450955533, 0.0, 3.999843853973347)
_K_HIGHPASS = Section(HIGHPASS, 38.13547087602444, 0.5003270373238773, 0.0)


def power_to_db(power):
    return _POWER_DB * np.log10(np.asarray(power, dtype=np.float64) + TINY)


def db_to_power(db):
    return 10.0 ** (np.asarray(db, dtype=np.float64) / _POWER_DB)


def bin_freqs(rate: int = ANALYSIS_RATE, frame: int = FRAME) -> np.ndarray:
    return np.fft.rfftfreq(frame, 1.0 / rate)


def coefficients_mag2(c: Coefficients, freqs, fs: float) -> np.ndarray:
    """|H|^2 of one biquad (a0 = 1) at ``freqs``."""
    b0, b1, b2, a1, a2 = c
    z = np.exp(-1j * 2.0 * np.pi * np.asarray(freqs, dtype=np.float64) / fs)
    return np.abs((b0 + b1 * z + b2 * z * z) / (1.0 + a1 * z + a2 * z * z)) ** 2


def sections_mag2(sections, freqs, fs: float) -> np.ndarray:
    """|H|^2 of a cascade of sections at ``freqs``."""
    out = np.ones(np.shape(freqs))
    for section in sections:
        out *= coefficients_mag2(section_coefficients(section, fs), freqs, fs)
    return out


def k_weight2(f: np.ndarray, rate: float = ANALYSIS_RATE) -> np.ndarray:
    """|K(f)|^2 of BS.1770's K-weighting at ``rate``."""
    return sections_mag2((_K_SHELF, _K_HIGHPASS), f, rate)


def band_index(freqs: np.ndarray) -> np.ndarray:
    """For every FFT bin, the third-octave band it belongs to (-1: none)."""
    idx = np.full(freqs.shape, -1, dtype=np.int64)
    for b, fc in enumerate(CENTRES_HZ):
        idx[(freqs >= fc / _EDGE) & (freqs < fc * _EDGE)] = b
    return idx


BIN_FREQS = bin_freqs()
_BAND_OF_BIN = band_index(BIN_FREQS)
K2 = k_weight2(BIN_FREQS)
_WINDOW = np.hanning(FRAME).astype(np.float64)
# One-sided spectrum: every bin but DC and Nyquist stands for two.
_SIDES = np.full(_BINS, 2.0)
_SIDES[0] = 1.0
_SIDES[-1] = 1.0
# |X|^2 * _SCALE is the bin's share of the windowed mean square (Parseval).
_SCALE = _SIDES / (FRAME * float(np.sum(_WINDOW**2)))


def bands_db(power: np.ndarray, band_of_bin: np.ndarray = _BAND_OF_BIN) -> np.ndarray:
    """Third-octave band levels (dB) of a power spectrum at FFT resolution."""
    inside = band_of_bin >= 0
    sums = np.bincount(band_of_bin[inside], weights=power[inside], minlength=N_BANDS)
    return power_to_db(sums[:N_BANDS])


def lufs_of(mean_square_k: float) -> float:
    return LUFS_OFFSET + float(power_to_db(mean_square_k))


def loudness_of_power(power: np.ndarray) -> float:
    """BS.1770-style loudness (LUFS) of a mean power spectrum."""
    return lufs_of(float(np.sum(power * K2)))


@dataclass
class Spectrum:
    """The gated long-term average of a signal."""

    power: np.ndarray  # mean power per FFT bin of the loud frames, channels summed
    frames: int
    gated_frames: int
    seconds: float

    @property
    def silent(self) -> bool:
        return self.gated_frames == 0

    @property
    def bands(self) -> np.ndarray:
        return bands_db(self.power)

    @property
    def gated_seconds(self) -> float:
        return self.gated_frames * HOP / ANALYSIS_RATE


class SpectrumAccumulator:
    """Feed interleaved stereo float32 samples in any chunk sizes; ``result()``
    gives the gated average. Memory: the histogram, about 21 MB, plus one
    frame of carry-over."""

    def __init__(self) -> None:
        self._hist = np.zeros((_GATE_BINS, _BINS), dtype=np.float64)
        self._count = np.zeros(_GATE_BINS, dtype=np.int64)
        self._energy = np.zeros(_GATE_BINS, dtype=np.float64)
        self._buf = np.zeros((0, CHANNELS), dtype=np.float32)
        self._frames = 0
        self._samples = 0

    def feed(self, interleaved: np.ndarray) -> None:
        x = np.asarray(interleaved, dtype=np.float32).reshape(-1, CHANNELS)
        self._samples += x.shape[0]
        buf = np.concatenate([self._buf, x]) if self._buf.size else x
        if buf.shape[0] < FRAME:
            self._buf = buf
            return
        starts = range(0, buf.shape[0] - FRAME + 1, HOP)
        for s in starts:
            self._frame(buf[s : s + FRAME])
        self._buf = buf[starts[-1] + HOP :].copy()

    def _frame(self, frame: np.ndarray) -> None:
        self._frames += 1
        spec = np.fft.rfft(frame.astype(np.float64) * _WINDOW[:, None], axis=0)
        power = (np.abs(spec[:, 0]) ** 2 + np.abs(spec[:, 1]) ** 2) * _SCALE
        ms_k = float(np.sum(power * K2))
        if ms_k <= 0.0:
            return
        lufs = lufs_of(ms_k)
        if lufs <= GATE_ABS_LUFS:
            return
        b = min(_GATE_BINS - 1, int((lufs - GATE_ABS_LUFS) / GATE_STEP_LU))
        self._hist[b] += power
        self._count[b] += 1
        self._energy[b] += ms_k

    def finish(self) -> None:
        """Analyse the last partial frame, zero padded, when it is long enough
        (or is all there is), so a short sound is not lost."""
        rest = self._buf.shape[0]
        if rest and (self._frames == 0 or rest >= _TAIL_MIN):
            pad = np.zeros((FRAME, CHANNELS), dtype=np.float32)
            pad[:rest] = self._buf[:FRAME]
            self._frame(pad)
        self._buf = np.zeros((0, CHANNELS), dtype=np.float32)

    def result(self) -> Spectrum:
        seconds = self._samples / ANALYSIS_RATE
        total = int(self._count.sum())
        if total == 0:
            return Spectrum(np.zeros(_BINS), self._frames, 0, seconds)
        threshold = lufs_of(float(self._energy.sum()) / total) + GATE_REL_LU
        centres = GATE_ABS_LUFS + (np.arange(_GATE_BINS) + 0.5) * GATE_STEP_LU
        keep = centres > threshold
        gated = int(self._count[keep].sum())
        if gated == 0:
            return Spectrum(np.zeros(_BINS), self._frames, 0, seconds)
        return Spectrum(self._hist[keep].sum(axis=0) / gated, self._frames, gated, seconds)


# Each band's response is the power average of four points inside it.
_SUB = np.array([-1 / 8, -1 / 24, 1 / 24, 1 / 8])
_EVAL_F = np.array([fc * 2.0**s for fc in CENTRES_HZ for s in _SUB])


def eq_mag2(bands: list[Band], freqs: np.ndarray, out_db: float = 0.0, fs=ANALYSIS_RATE):
    """|H|^2 of a whole EQ (bands and output gain) at ``freqs``."""
    m = np.full(freqs.shape, db_to_linear(out_db) ** 2)
    for b in bands:
        m *= sections_mag2(band_sections(b), freqs, fs)
    return m


def band_response_db(band: Band) -> np.ndarray:
    """A band's response on the 31 bands."""
    m = sections_mag2(band_sections(band), _EVAL_F, ANALYSIS_RATE).reshape(N_BANDS, len(_SUB))
    return power_to_db(m.mean(axis=1))


def apply_eq(power: np.ndarray, bands: list[Band], out_db: float = 0.0) -> np.ndarray:
    """A fine (FFT-bin) power spectrum after an EQ: exact, at the analysis rate."""
    return power * eq_mag2(bands, BIN_FREQS, out_db)


def band_levels_after(power: np.ndarray, bands: list[Band], out_db: float = 0.0) -> np.ndarray:
    return bands_db(apply_eq(power, bands, out_db))


def loudness_change_db(power: np.ndarray, bands: list[Band], out_db: float = 0.0) -> float:
    """How much an EQ changes the K-weighted loudness of ``power`` (dB/LU)."""
    before = float(np.sum(power * K2))
    if before <= 0:
        return 0.0
    after = float(np.sum(apply_eq(power, bands, out_db) * K2))
    return float(power_to_db(after / before))


def spectrum_to_json(s: Spectrum) -> dict:
    """The cache form: the gated power spectrum in dB (about 65 KB)."""
    db = power_to_db(s.power)
    return {
        "frames": s.frames,
        "gated_frames": s.gated_frames,
        "seconds": round(s.seconds, _CACHE_DECIMALS),
        "power_db": [round(float(v), _CACHE_DECIMALS) for v in db],
    }


def spectrum_from_json(data: dict) -> Spectrum:
    db = np.asarray(data["power_db"], dtype=np.float64)
    if db.shape != (_BINS,) or not np.all(np.isfinite(db)):
        raise ValueError("bad cached spectrum")
    power = db_to_power(db)
    power[db <= _CACHE_FLOOR_DB] = 0.0
    return Spectrum(power, int(data["frames"]), int(data["gated_frames"]), float(data["seconds"]))
