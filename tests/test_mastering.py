"""The master (app/pipeline/mastering.py): the master= parser, the filter
strings, the plan maths against a stubbed meter, the on-disk plan cache
(app/pipeline/master_plan_cache.py), and
one real ffmpeg run on a synthetic tone checked with independent oracles
(pyloudnorm for loudness, a 4x numpy oversample for the true peak).
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import subprocess

import numpy as np
import pyloudnorm
import pytest
import soundfile as sf
from scipy.signal import resample_poly

from app.core.config import (
    EXPORT_LIMIT_LOSSY_DBTP,
    MASTER_COMP_THRESHOLD_FLOOR_DB,
    MASTER_CORRECTION_MAX_DB,
    MASTER_CORRECTION_PASSES,
    MASTER_CORRECTION_TOL_LU,
    MASTER_GAIN_MAX_DB,
    MASTER_LIMITER_MARGIN_DB,
    MASTER_PARAM_MAX_CHARS,
    MASTER_TRIM_MARGIN_DB,
    ffmpeg_executable,
)
from app.pipeline import master_plan_cache as cache
from app.pipeline import mastering as m
from app.pipeline.mastering import Loudness, MasterError, MasterSettings
from tests.ffmpeg_probe import skip_without_ffmpeg

SR = 44100
STREAMING = MasterSettings(-14.0, -1.0)
# One lane up to [pre], as app/api/export_fx.py measures a single stem.
ONE_LANE_GRAPH = "[0:a]anull[a0];[a0]anull[pre]"
INTEGRATION_TOLERANCE_LU = 0.5


def raw_param(body) -> str:
    text = body if isinstance(body, str) else json.dumps(body)
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def test_parse_round_trips_and_canonicalises():
    s = m.parse_master_param(raw_param({"v": 1, "target": -14.04, "ceiling": -1.01, "comp": 0.333}))
    assert s == MasterSettings(target=-14.0, ceiling=-1.0, comp=0.33)
    assert m.parse_master_param(m.encode_master_param(s)) == s
    limiter_only = m.parse_master_param(raw_param({"v": 1, "target": None, "ceiling": -1}))
    assert limiter_only == MasterSettings(None, -1.0, 0.0)
    assert m.parse_master_param("") is None
    assert m.parse_master_param(None) is None


def test_the_loudness_route_requires_a_master():
    with pytest.raises(MasterError, match="^master: required$"):
        m.require_master_param("")
    assert m.require_master_param(m.encode_master_param(STREAMING)) == STREAMING


BAD = [
    ("!!!", "master: malformed"),
    ("a" * (MASTER_PARAM_MAX_CHARS + 1), "master: malformed"),
    (raw_param("not json"), "master: malformed"),
    (raw_param([1, 2]), "master: malformed"),
    (raw_param({"v": 1, "target": -14, "ceiling": -1, "extra": 1}), "master: malformed"),
    (raw_param("[" * 5000 + "]" * 5000), "master: malformed"),
    ("eyJ2IjoxfQ==", "master: malformed"),
    (base64.urlsafe_b64encode(b"\xff\xfe").decode().rstrip("="), "master: malformed"),
    (raw_param('{"v": 1, "target": NaN, "ceiling": -1}'), "master: malformed"),
    (raw_param({"v": 1, "target": "-14", "ceiling": -1}), "master: malformed"),
    (raw_param({"v": 1, "target": [-14], "ceiling": -1}), "master: malformed"),
    (raw_param({"v": 1, "target": -14, "ceiling": True}), "master: malformed"),
    (raw_param({"v": 2, "target": -14, "ceiling": -1}), "master: unsupported version"),
    (raw_param({"v": True, "target": -14, "ceiling": -1}), "master: unsupported version"),
    (raw_param({"target": -14, "ceiling": -1}), "master: unsupported version"),
    (raw_param({"v": 1, "ceiling": -1}), "master: target and ceiling are required"),
    (raw_param({"v": 1, "target": -14}), "master: target and ceiling are required"),
    (raw_param('{"v": 1, "target": -1e999, "ceiling": -1}'), "master: target out of range"),
    (raw_param({"v": 1, "target": -5, "ceiling": -1}), "master: target out of range"),
    (raw_param({"v": 1, "target": -40, "ceiling": -1}), "master: target out of range"),
    (raw_param({"v": 1, "target": -14, "ceiling": 0}), "master: ceiling out of range"),
    (raw_param({"v": 1, "target": -14, "ceiling": -10}), "master: ceiling out of range"),
    (raw_param({"v": 1, "target": -14, "ceiling": -1, "comp": 2}), "master: comp out of range"),
    (raw_param({"v": 1, "target": -14, "ceiling": -1, "comp": -0.1}), "master: comp out of range"),
]


@pytest.mark.parametrize(("raw", "message"), BAD)
def test_malformed_master_values_are_refused(raw, message):
    with pytest.raises(MasterError) as err:
        m.parse_master_param(raw)
    assert str(err.value) == message


@pytest.mark.parametrize(
    ("fmt", "ceiling", "expected"),
    [
        ("mp3", -0.5, EXPORT_LIMIT_LOSSY_DBTP),
        ("ogg", -0.5, EXPORT_LIMIT_LOSSY_DBTP),
        ("aac", -0.5, EXPORT_LIMIT_LOSSY_DBTP),
        ("wav", -0.5, -0.5),
        ("flac", -0.5, -0.5),
        ("mp3", -2.0, -2.0),
    ],
)
def test_lossy_ceiling_never_above_the_lossy_limit(fmt, ceiling, expected):
    assert m.effective_ceiling(MasterSettings(-14.0, ceiling), fmt) == expected


def test_compressor_threshold_follows_the_measured_loudness():
    assert m.comp_threshold_db(0.0, -14.0, -12.0) is None
    assert m.comp_threshold_db(0.5, None, -12.0) is None
    assert m.comp_threshold_db(0.5, -14.0, -12.0) == pytest.approx(-13.0)
    assert m.comp_threshold_db(1.0, -14.0, -12.0) == pytest.approx(-16.0)
    assert m.comp_threshold_db(1.0, -14.0, -69.0) == MASTER_COMP_THRESHOLD_FLOOR_DB
    assert m.comp_threshold_db(0.1, -14.0, 0.0) == 0.0
    assert m.comp_ratio(0.5) == 2.0


def test_compressor_string():
    assert m.comp_filter(0.0, None) == ""
    assert m.comp_filter(0.5, -13.0) == (
        f"acompressor=threshold={10 ** (-13 / 20):.8f}:ratio=2.0:attack=20:release=250"
        f":knee={10 ** (6 / 20):.6f}:detection=rms:link=average:makeup=1"
    )


def test_limiter_is_oversampled_with_level_disabled():
    f = m.limiter_filter(-1.0, SR)
    assert f.startswith("aresample=176400,alimiter=")
    assert f.endswith(",aresample=44100")
    assert ":attack=5:release=50:level=disabled:latency=1," in f
    limit = float(f.split("limit=")[1].split(":")[0])
    assert limit == pytest.approx(10 ** ((-1.0 - MASTER_LIMITER_MARGIN_DB) / 20), rel=1e-6)


def test_master_chain_order_and_off_states():
    chain = m.master_chain(0.5, -18.0, 3.0, -1.0, SR)
    assert chain.index("acompressor=") < chain.index("volume=") < chain.index("alimiter=")
    assert f"volume={10 ** (3 / 20):.8f}," in chain
    assert "acompressor" not in m.master_chain(0.0, None, 3.0, -1.0, SR)
    assert m.master_chain(0.0, None, 0.0, -1.0, SR) == m.limiter_filter(-1.0, SR)


def test_filter_strings_carry_only_numbers():
    chain = m.master_chain(1.0, -60.0, 20.0, -0.1, 48000)
    for part in chain.split(","):
        name, _, opts = part.partition("=")
        assert name in {"acompressor", "volume", "aresample", "alimiter"}
        for opt in opts.split(":"):
            value = opt.split("=")[-1]
            assert value in {"rms", "average", "disabled"} or float(value) == float(value)


def test_meter_output_parser_takes_the_last_values():
    text = "\n".join(
        [
            "[a @ 0] lavfi.r128.I=-30.000",
            "[a @ 0] lavfi.r128.LRA=0.000",
            "[a @ 0] lavfi.r128.true_peak=0.100",
            "[a @ 0] lavfi.r128.I=-14.123",
            "[a @ 0] lavfi.r128.LRA=5.500",
            "[a @ 0] lavfi.r128.true_peak=0.891",
        ]
    )
    got = m.parse_meter(text)
    assert got.i == -14.123 and got.lra == 5.5
    assert got.tp == pytest.approx(20 * np.log10(0.891), abs=1e-3)
    silent = m.parse_meter("lavfi.r128.I=-70.000\nlavfi.r128.true_peak=0.000")
    assert silent.i is None and silent.tp is None
    assert m.parse_meter("garbage") == Loudness(None, None, None)
    assert m.parse_meter("lavfi.r128.I=nan").i is None


def _chain_gain_db(chain: str) -> float:
    if "volume=" not in chain:
        return 0.0
    return float(20 * np.log10(float(chain.split("volume=")[1].split(",")[0])))


def _stub_meter(pre_lufs: float, knee_lufs: float, slope: float, calls: list[str] | None = None):
    """A mix at pre_lufs whose limiter turns 1 dB of gain into ``slope`` LU above knee_lufs."""

    async def measure(inputs, graph, chain, rate):
        if calls is not None:
            calls.append(chain)
        raw = pre_lufs + _chain_gain_db(chain)
        level = raw if raw <= knee_lufs else knee_lufs + slope * (raw - knee_lufs)
        return Loudness(round(level, 3), -1.1)

    return measure


def _plan(settings: MasterSettings, measure) -> m.MasterPlan:
    return asyncio.run(m.run_plan([], "", settings, settings.ceiling, SR, measure))


def test_a_clean_mix_reaches_the_target_in_one_pass():
    calls: list[str] = []
    plan = _plan(STREAMING, _stub_meter(-20.0, 0.0, 1.0, calls))
    assert plan.gain_db == pytest.approx(6.0)
    assert plan.post.i == -14.0 and plan.reached and len(calls) == 2


def test_correction_steps_along_the_measured_slope():
    calls: list[str] = []
    plan = _plan(MasterSettings(-9.0, -1.0), _stub_meter(-16.0, -10.0, 0.6, calls))
    assert plan.pre.i == -16.0
    assert abs(plan.post.i - -9.0) <= MASTER_CORRECTION_TOL_LU
    assert plan.reached
    assert len(calls) <= 2 + MASTER_CORRECTION_PASSES


def test_corrections_are_bounded_in_count_and_step():
    calls: list[str] = []
    plan = _plan(MasterSettings(-6.0, -1.0), _stub_meter(-20.0, -12.0, 0.1, calls))
    gains = [_chain_gain_db(c) for c in calls[1:]]
    assert len(gains) == 1 + MASTER_CORRECTION_PASSES
    steps = np.diff(gains)
    assert np.all(np.abs(steps) <= MASTER_CORRECTION_MAX_DB + 1e-6)
    assert not plan.reached


def test_gain_is_clamped():
    plan = _plan(STREAMING, _stub_meter(-60.0, 0.0, 1.0))
    assert plan.gain_db == MASTER_GAIN_MAX_DB and not plan.reached


def test_the_compressor_is_measured_before_the_gain():
    calls: list[str] = []
    plan = _plan(MasterSettings(-14.0, -1.0, 0.5), _stub_meter(-20.0, 0.0, 1.0, calls))
    assert "acompressor" in calls[1] and "volume" not in calls[1]
    assert plan.comp_threshold_db == pytest.approx(-21.0) and plan.comp_i == -20.0


def test_no_target_and_silence_mean_no_gain():
    limiter_only = _plan(MasterSettings(None, -1.0), _stub_meter(-20.0, 0.0, 1.0))
    assert limiter_only.gain_db == 0.0 and limiter_only.reached
    calls: list[str] = []

    async def silence(inputs, graph, chain, rate):
        calls.append(chain)
        return Loudness(None, None)

    silent = _plan(MasterSettings(-14.0, -1.0, 0.5), silence)
    assert silent.gain_db == 0.0 and len(calls) == 3 and not silent.reached


def test_no_target_runs_only_the_limiter_whatever_the_comp():
    calls: list[str] = []
    plan = _plan(MasterSettings(None, -1.0, 0.5), _stub_meter(-20.0, 0.0, 1.0, calls))
    assert not any("acompressor" in c for c in calls)
    assert plan.comp_threshold_db is None and plan.comp_i is None
    assert m.plan_chain(plan, SR) == m.limiter_filter(-1.0, SR)


CONTRACT_PLAN_KEYS = [
    "target",
    "ceiling",
    "comp",
    "comp_ratio",
    "pre",
    "comp_threshold_db",
    "comp_i",
    "gain_db",
    "post",
    "reached",
    "limit_offset_db",
    "trim_db",
]


def test_plan_json_is_the_loudness_route_shape():
    off = _plan(STREAMING, _stub_meter(-20.0, 0.0, 1.0)).to_json()
    assert list(off) == CONTRACT_PLAN_KEYS
    assert off["comp_ratio"] is None
    assert set(off["pre"]) == {"i", "tp", "lra"}
    glued = _plan(MasterSettings(-14.0, -1.0, 0.5), _stub_meter(-20.0, 0.0, 1.0)).to_json()
    assert glued["comp_ratio"] == 2.0


LIMIT_RE = re.compile(r"alimiter=limit=([\d.]+)")
TRIM_RE = re.compile(r"volume=([\d.]+)$")


def _limiter_meter(overshoot_db: float, follows_limit: bool = True):
    """The limiter's output peaks ``overshoot_db`` over its limit (or over its
    first limit, when it does not follow it); a lower limit costs a little
    loudness, a trim after it costs its full amount."""

    async def measure(inputs, graph, chain, rate):
        if not chain:
            return Loudness(-20.0, -3.0)
        limit = m.linear_to_db(float(LIMIT_RE.search(chain).group(1)))
        offset = -1.0 - MASTER_LIMITER_MARGIN_DB - limit
        trim_match = TRIM_RE.search(chain.split(f"aresample={rate}")[-1])
        trim = -m.linear_to_db(float(trim_match.group(1))) if trim_match else 0.0
        peak_limit = limit if follows_limit else limit + offset
        loudness = -14.0 - 0.02 * offset - trim
        return Loudness(round(loudness, 3), round(peak_limit + overshoot_db - trim, 3))

    return measure


def test_an_overshoot_lowers_the_limit_and_keeps_the_loudness():
    calls: list[str] = []
    plan = _plan(STREAMING, _logged(_limiter_meter(0.4), calls))
    assert plan.limit_offset_db == pytest.approx(0.3 + MASTER_TRIM_MARGIN_DB)
    assert plan.trim_db == 0.0 and plan.gain_db == pytest.approx(6.0)
    assert m.limiter_filter(-1.0 - plan.limit_offset_db, SR) in m.plan_chain(plan, SR)
    assert plan.post.tp <= STREAMING.ceiling
    assert abs(plan.post.i - STREAMING.target) <= MASTER_CORRECTION_TOL_LU and plan.reached


def test_a_lower_limit_that_costs_loudness_is_made_up_with_gain():
    """A hard-working limiter: each dB off its limit costs half an LU, each dB
    of gain into it buys 0.6, so the gain follows the target once the limit moved."""

    async def measure(inputs, graph, chain, rate):
        if not chain:
            return Loudness(-20.0, -3.0)
        limit = m.linear_to_db(float(LIMIT_RE.search(chain).group(1)))
        offset = -1.0 - MASTER_LIMITER_MARGIN_DB - limit
        loudness = -14.0 + 0.6 * (_chain_gain_db(chain) - 6.0) - 0.5 * offset
        return Loudness(round(loudness, 3), round(limit + 0.4, 3))

    plan = _plan(STREAMING, measure)
    assert plan.limit_offset_db == pytest.approx(0.3 + MASTER_TRIM_MARGIN_DB)
    assert plan.gain_db > 6.0 and plan.trim_db == 0.0
    assert plan.post.tp <= STREAMING.ceiling
    assert abs(plan.post.i - STREAMING.target) <= MASTER_CORRECTION_TOL_LU and plan.reached


def test_a_limit_that_does_not_help_falls_back_to_a_trim():
    plan = _plan(STREAMING, _limiter_meter(0.4, follows_limit=False))
    assert plan.limit_offset_db > 0 and plan.trim_db > 0
    assert plan.post.tp <= STREAMING.ceiling
    assert not plan.reached


def test_a_ceiling_still_missed_means_the_target_is_not_reached():
    async def stuck(inputs, graph, chain, rate):
        return Loudness(-20.0, -3.0) if not chain else Loudness(-14.0, -0.7)

    plan = _plan(STREAMING, stuck)
    assert plan.post.i == -14.0 and plan.post.tp > STREAMING.ceiling
    assert not plan.reached


def test_a_peak_under_the_ceiling_is_left_alone():
    plan = _plan(STREAMING, _stub_meter(-20.0, 0.0, 1.0))
    assert plan.limit_offset_db == 0.0 and plan.trim_db == 0.0 and m.trim_filter(0.0) == ""


def _logged(measure, calls: list[str]):
    async def logged(inputs, graph, chain, rate):
        calls.append(chain)
        return await measure(inputs, graph, chain, rate)

    return logged


def test_plan_round_trips_through_json():
    plan = _plan(STREAMING, _stub_meter(-20.0, 0.0, 1.0))
    assert m.MasterPlan.from_json(json.loads(json.dumps(plan.to_json()))) == plan


def _stem(tmp_path, name="drums.wav"):
    path = tmp_path / name
    path.write_bytes(b"RIFF")
    return path


@pytest.fixture
def plan_dir(tmp_path, monkeypatch):
    path = tmp_path / "plans"
    monkeypatch.setattr(cache, "MASTER_PLAN_CACHE_DIR", path)
    return path


def _cached(stem, settings, calls, graph="g", fmt="wav"):
    meter = _stub_meter(-20.0, 0.0, 1.0, calls)
    return asyncio.run(cache.cached_plan([stem], graph, settings, fmt, SR, measure=meter))


def test_a_plan_is_measured_once_and_read_back(tmp_path, plan_dir):
    stem, calls = _stem(tmp_path), []
    first = _cached(stem, STREAMING, calls)
    measured = len(calls)
    assert _cached(stem, STREAMING, calls) == first
    assert len(calls) == measured


def test_the_key_follows_mix_master_format_and_the_stem_files(tmp_path):
    stem = _stem(tmp_path)
    key = cache.plan_cache_key([stem], "g", STREAMING, -1.0, SR)
    assert cache.plan_cache_key([stem], "g2", STREAMING, -1.0, SR) != key
    assert cache.plan_cache_key([stem], "g", MasterSettings(-9.0, -1.0), -1.0, SR) != key
    assert cache.plan_cache_key([stem], "g", STREAMING, -1.5, SR) != key
    stat = stem.stat()
    os.utime(stem, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1))
    assert cache.plan_cache_key([stem], "g", STREAMING, -1.0, SR) != key


def test_a_corrupt_cache_entry_is_measured_again(tmp_path, plan_dir):
    stem, calls = _stem(tmp_path), []
    _cached(stem, STREAMING, calls)
    assert any(plan_dir.iterdir())
    for entry in plan_dir.iterdir():
        entry.write_text("{", encoding="utf-8")
    measured = len(calls)
    _cached(stem, STREAMING, calls)
    assert len(calls) > measured


def _tone_with_spikes(seconds: float = 6.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    x = 10 ** (-30 / 20) * np.sin(2 * np.pi * 997 * t)
    x[:: SR // 2] = 0.5  # spikes the +16 dB gain would push past full scale
    return np.stack([x, x], 1)


def _render(tmp_path, src, graph: str, chain: str) -> np.ndarray:
    dst = tmp_path / "mastered.wav"
    cmd = [ffmpeg_executable(), "-nostdin", "-loglevel", "error", "-y", "-i", str(src)]
    cmd += ["-filter_complex", f"{graph};[pre]{chain}[out]", "-map", "[out]"]
    subprocess.run([*cmd, "-c:a", "pcm_f32le", str(dst)], check=True, timeout=120)
    return sf.read(dst, dtype="float64", always_2d=True)[0]


def test_a_tone_is_mastered_to_the_target_under_the_ceiling(tmp_path, plan_dir):
    skip_without_ffmpeg()
    src = tmp_path / "tone.wav"
    sf.write(src, _tone_with_spikes(), SR, subtype="PCM_16")
    graph = ONE_LANE_GRAPH
    plan = asyncio.run(cache.cached_plan([src], graph, STREAMING, "wav", SR))
    x = _render(tmp_path, src, graph, m.plan_chain(plan, SR))
    lufs = pyloudnorm.Meter(SR).integrated_loudness(x)
    true_peak = 20 * np.log10(np.abs(resample_poly(x, 4, 1, axis=0)).max())
    assert lufs == pytest.approx(STREAMING.target, abs=INTEGRATION_TOLERANCE_LU)
    assert true_peak <= STREAMING.ceiling
