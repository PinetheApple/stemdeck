from __future__ import annotations

import json

import numpy as np
import pytest

from app.pipeline import tempo_grid
from app.pipeline.tempo import constant_beats, cover_full_duration, fit_constant_tempo, number_beats
from app.pipeline.tempo_grid import effective_grid, read_detected_grid

BPM = 100.0
PERIOD = 60.0 / BPM


def _live_take(seed: int = 7) -> tuple[list[float], list[float]]:
    """200 beats at 100 BPM as a tracker hears a live band.

    Human jitter throughout, beats 40-79 tracked at half time, 100-139 at double
    time, and a ritardando over the last 20 beats. Downbeats every 4 beats from
    beat 2, the bar phase a fit must recover.
    """
    rng = np.random.default_rng(seed)
    true = 3.0 + np.arange(200) * PERIOD + rng.normal(0, 0.004, 200)
    true[180:] += np.cumsum(np.linspace(0, 0.25, 20)) * PERIOD
    beats: list[float] = []
    for i, t in enumerate(true):
        if 40 <= i < 80 and i % 2:
            continue
        beats.append(float(t))
        if 100 <= i < 140:
            beats.append(float(t + PERIOD / 2))
    downbeats = [float(true[i]) for i in range(2, 200, 4)]
    return beats, downbeats


def test_fit_recovers_tempo_through_tracker_level_switches_and_ritardando():
    """Least squares on the same beats lands 0.25 BPM slow, which drifts a
    200-beat song by over 100 ms; the robust fit must not."""
    beats, downbeats = _live_take()
    tempo = fit_constant_tempo(beats, downbeats)
    assert tempo is not None
    assert tempo["bpm"] == pytest.approx(BPM, abs=0.05)
    assert tempo["fit"]["method"] == "theil-sen"
    assert tempo["fit"]["median_drift_ms"] < 6.0


def test_fit_anchors_on_the_downbeat_phase():
    beats, downbeats = _live_take()
    tempo = fit_constant_tempo(beats, downbeats)
    assert tempo["beats_per_bar"] == 4
    assert tempo["anchor"] == pytest.approx(3.0 + 2 * PERIOD, abs=0.01)


def test_fit_reads_the_meter_off_downbeat_spacing():
    beats = [1.0 + i * PERIOD for i in range(60)]
    tempo = fit_constant_tempo(beats, beats[1::3])
    assert tempo["beats_per_bar"] == 3
    assert tempo["anchor"] == pytest.approx(beats[1], abs=1e-6)


def test_fit_without_downbeats_anchors_on_the_first_beat_in_four():
    beats = [1.0 + i * PERIOD for i in range(60)]
    tempo = fit_constant_tempo(beats, [])
    assert tempo["beats_per_bar"] == 4
    assert tempo["anchor"] == pytest.approx(1.0, abs=1e-6)
    assert tempo["fit"]["downbeats_used"] == 0


def test_fit_refuses_an_implausible_tempo():
    assert fit_constant_tempo([0.0, 5.0, 10.0, 15.0], []) is None
    assert fit_constant_tempo([1.0], []) is None


def test_numbering_counts_skipped_beats_and_drops_doubled_ones():
    beats = [0.0, 0.6, 1.8, 2.1, 2.4, 3.0]
    numbers, times = number_beats(beats, 0.6)
    assert numbers == [0, 1, 3, 4, 5]
    assert times == [0.0, 0.6, 1.8, 2.4, 3.0]


def test_constant_beats_span_the_whole_song_from_the_anchor():
    beats, anchor_index = constant_beats(120.0, 1.3, 10.0)
    assert beats[0] == pytest.approx(0.3)
    assert beats[-1] <= 10.0 and beats[-1] > 10.0 - 0.5
    assert beats[anchor_index] == pytest.approx(1.3)
    assert np.allclose(np.diff(beats), 0.5, atol=1e-6)


def test_constant_beats_include_both_ends_when_they_land_exactly():
    beats, anchor_index = constant_beats(120.0, 0.0, 2.0)
    assert beats == [0.0, 0.5, 1.0, 1.5, 2.0]
    assert anchor_index == 0


def test_follow_coverage_fills_holes_and_both_edges():
    detected = [5.0, 5.6, 6.2, 9.8, 10.4, 11.0]
    beats, head, tail, filled = cover_full_duration(detected, 0.6, 13.9)
    assert beats[0] < 0.6 and head == 8
    assert beats[-1] > 13.9 - 0.6 and tail == 4
    assert filled == 5
    assert max(np.diff(beats)) <= 0.6 * 1.5
    assert set(detected) <= set(beats)


_DETECTED = {"mode": "constant", "bpm": 120.0, "anchor": 1.0, "beats_per_bar": 4}


def _grid(**over) -> dict:
    grid = {
        "beats": [1.0, 1.5, 2.0, 2.5],
        "bars": [{"beat": 0, "beats_per_bar": 4}],
        "duration": 4.0,
        "bpm": 120.0,
        "tempo": dict(_DETECTED, source="detected"),
    }
    grid.update(over)
    return grid


def test_constant_mode_materialises_beats_and_bars_from_the_formula():
    out = effective_grid(_grid(), {})
    assert out["beats"] == [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]
    # The anchor (1.0) is index 2, so bar lines fall on indices 2, 6, ...
    assert out["bars"] == [{"beat": 2, "beats_per_bar": 4}]
    assert out["tempo"]["source"] == "detected"
    assert out["edited"] is False


def test_user_values_win_key_by_key():
    out = effective_grid(_grid(), {"tempo": {"bpm": 60.0}})
    assert out["tempo"]["bpm"] == 60.0
    assert out["tempo"]["anchor"] == 1.0
    assert out["tempo"]["source"] == "user"
    assert out["beats"] == [0.0, 1.0, 2.0, 3.0, 4.0]
    assert out["bpm"] == 60.0


def test_follow_mode_plays_the_detected_beats_continued_over_the_song():
    out = effective_grid(_grid(), {"tempo": {"mode": "follow"}})
    assert out["beats"] == [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0]
    assert out["bars"] == [{"beat": 2, "beats_per_bar": 4}]


def test_follow_mode_takes_bar_lines_from_a_user_anchor():
    out = effective_grid(_grid(), {"tempo": {"mode": "follow", "anchor": 2.0, "beats_per_bar": 3}})
    assert out["bars"] == [{"beat": 1, "beats_per_bar": 3}]


def test_follow_mode_keeps_user_edited_bars_over_a_user_anchor():
    edits = {
        "beats": [1.1, 1.6, 2.1],
        "bars": [{"beat": 0, "beats_per_bar": 4}, {"beat": 2, "beats_per_bar": 3}],
        "tempo": {"mode": "follow", "anchor": 1.6, "beats_per_bar": 3},
    }
    out = effective_grid(_grid(), edits)
    first = out["beats"].index(1.1)
    assert out["bars"] == [
        {"beat": first, "beats_per_bar": 4},
        {"beat": first + 2, "beats_per_bar": 3},
    ]


def test_beat_edits_saved_before_tempo_existed_keep_following_over_the_song():
    out = effective_grid(_grid(), {"beats": [1.1, 1.6], "bars": []})
    assert out["tempo"]["mode"] == "follow"
    assert out["beats"] == pytest.approx([0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1, 3.6])


def _legacy_file(tmp_path, **over):
    beats = [0.25 + i * 0.5 for i in range(16)]
    grid = {"beats": beats, "bars": [{"beat": 1, "beats_per_bar": 4}], "duration": 9.0}
    grid.update(over)
    path = tmp_path / "beats.json"
    path.write_text(json.dumps(grid), encoding="utf-8")
    return path


def test_a_grid_analysed_before_tempo_existed_is_fitted_once_and_saved(tmp_path, monkeypatch):
    path = _legacy_file(tmp_path)
    out = effective_grid(read_detected_grid(path), {})
    assert out["tempo"]["mode"] == "constant"
    assert out["tempo"]["bpm"] == pytest.approx(120.0, abs=1e-3)
    assert out["tempo"]["anchor"] == pytest.approx(0.75, abs=1e-6)
    assert out["beats"][0] == pytest.approx(0.25) and out["beats"][-1] == pytest.approx(8.75)
    assert json.loads(path.read_text())["tempo"]["bpm"] == out["tempo"]["bpm"]

    def _refit(*_args, **_kwargs):
        raise AssertionError("refitted a saved tempo")

    monkeypatch.setattr(tempo_grid, "fit_constant_tempo", _refit)
    assert read_detected_grid(path)["tempo"]["bpm"] == out["tempo"]["bpm"]


def test_a_legacy_fit_leaves_out_extrapolated_edge_beats(tmp_path):
    head = [i * 0.6 for i in range(12)]
    beats = head + [7.2 + i * 0.5 for i in range(8)] + [11.2, 11.8]
    path = _legacy_file(tmp_path, beats=beats, bars=[], extrapolated_head=12, extrapolated_tail=2)
    assert read_detected_grid(path)["tempo"]["bpm"] == pytest.approx(120.0, abs=1e-3)


def test_a_legacy_grid_with_no_usable_tempo_is_saved_as_none(tmp_path):
    path = _legacy_file(tmp_path, beats=[1.0])
    assert read_detected_grid(path)["tempo"] is None
    assert json.loads(path.read_text())["tempo"] is None


def test_a_grid_with_no_usable_tempo_follows_its_beats():
    out = effective_grid({"beats": [1.0], "duration": 4.0, "tempo": None}, {})
    assert out["tempo"]["mode"] == "follow"
    assert out["beats"] == [1.0]
