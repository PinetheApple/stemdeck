"""app.core.takes and app.api.takes_lanes: the files a take is made of, the
keep rule auto-delete will ask, the track list, and export lane resolution."""

from __future__ import annotations

import json
import time

import pytest

from app.api import takes_lanes
from app.core import takes
from app.core.takes_config import (
    AUDIO_PART_FILE,
    PARTS_FILE,
    RAW_WAV_FILE,
    SIDECAR_FILE,
    TAKE_OPEN_STALE_SEC,
    TAKE_WAV_FILE,
    TAKES_DIRNAME,
)

JOB = "abcdefabcdef"
TAKE = "t0000000a"
TAKE_B = "t0000000b"
TRACK = "k0000000a"


@pytest.fixture
def job_dir(tmp_path):
    folder = tmp_path / JOB
    (folder / "stems").mkdir(parents=True)
    return folder


def _take_folder(job_dir, take_id=TAKE):
    folder = job_dir / TAKES_DIRNAME / take_id
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _finished(job_dir, take_id=TAKE, track_id=TRACK, created_at=1.0, **extra):
    folder = _take_folder(job_dir, take_id)
    sidecar = {
        "v": 1,
        "id": take_id,
        "track_id": track_id,
        "label": "Take 1",
        "created_at": created_at,
        "timeline": {"frame0_song_sec": 1.0, "tempo": 1.0},
        "latency": {"round_trip_ms": 20.0, "source": "calibrated", "user_nudge_ms": 0.0},
        "capture": {"rate": 48000, "channels": 1},
        "placement_sec": 0.98,
        "duration_sec": 3.0,
        **extra,
    }
    (folder / SIDECAR_FILE).write_text(json.dumps(sidecar), encoding="utf-8")
    (folder / TAKE_WAV_FILE).write_bytes(b"RIFF")
    return folder


def _open(job_dir, take_id=TAKE, part=b"\0" * 8, updated_at=None):
    folder = _take_folder(job_dir, take_id)
    state = {
        "label": "Take 1",
        "track_id": TRACK,
        "created_at": 1.0,
        "updated_at": time.time() if updated_at is None else updated_at,
        "finished": False,
        "audio": {"next_seq": 1, "bytes": len(part)},
    }
    (folder / PARTS_FILE).write_text(json.dumps(state), encoding="utf-8")
    (folder / AUDIO_PART_FILE).write_bytes(part)
    return folder


def test_take_dir_resolves_inside_the_jobs_dir(tmp_path):
    assert takes.take_dir(tmp_path, JOB, TAKE) == (tmp_path / JOB / TAKES_DIRNAME / TAKE).resolve()


@pytest.mark.parametrize(
    ("job_id", "take_id"),
    [("../etc", TAKE), (JOB, "../x"), (JOB, "t123"), (JOB, "k0000000a"), ("ABCDEFABCDEF", TAKE)],
)
def test_take_dir_refuses_malformed_ids(tmp_path, job_id, take_id):
    assert takes.take_dir(tmp_path, job_id, take_id) is None


def test_new_id_avoids_existing_ids():
    made = takes.new_id("t", set())
    assert takes.new_id("t", {made}) != made
    assert made.startswith("t") and len(made) == 9


def test_read_json_answers_empty_for_missing_or_bad_files(tmp_path):
    assert takes.read_json(tmp_path / "none.json") == {}
    bad = tmp_path / "bad.json"
    bad.write_text("{nope", encoding="utf-8")
    assert takes.read_json(bad) == {}


def test_has_takes_false_without_a_takes_folder(job_dir):
    assert takes.has_takes(job_dir) is False


def test_has_takes_true_for_a_finished_take(job_dir):
    _finished(job_dir)
    assert takes.has_takes(job_dir) is True


def test_has_takes_true_for_an_open_take_with_audio(job_dir):
    _open(job_dir)
    assert takes.has_takes(job_dir) is True


def test_has_takes_true_for_a_folder_with_only_a_sidecar(job_dir):
    (_take_folder(job_dir) / SIDECAR_FILE).write_text("{}", encoding="utf-8")
    assert takes.has_takes(job_dir) is True


def test_has_takes_true_mid_finish_when_only_the_raw_capture_is_left(job_dir):
    (_take_folder(job_dir) / RAW_WAV_FILE).write_bytes(b"RIFF")
    assert takes.has_takes(job_dir) is True


def test_has_takes_false_for_an_open_take_with_nothing_received(job_dir):
    _open(job_dir, part=b"")
    assert takes.has_takes(job_dir) is False


def test_has_takes_ignores_folders_that_are_not_takes(job_dir):
    (job_dir / TAKES_DIRNAME / "notatake").mkdir(parents=True)
    (job_dir / TAKES_DIRNAME / "notatake" / SIDECAR_FILE).write_text("{}", encoding="utf-8")
    assert takes.has_takes(job_dir) is False


def test_has_takes_true_when_the_takes_folder_cannot_be_read(job_dir, monkeypatch):
    _finished(job_dir)

    def unreadable(self):
        raise PermissionError("denied")

    monkeypatch.setattr(type(job_dir), "iterdir", unreadable)
    assert takes.has_takes(job_dir) is True


def test_scan_splits_finished_and_open_takes(job_dir):
    _finished(job_dir, TAKE)
    _open(job_dir, TAKE_B)
    finished, open_ = takes.scan_takes(job_dir, now=time.time())
    assert [s["id"] for s in finished] == [TAKE]
    assert [o["id"] for o in open_] == [TAKE_B]
    assert open_[0]["bytes"] == 8
    assert open_[0]["recoverable"] is False


def test_scan_marks_a_stale_open_take_recoverable(job_dir):
    _open(job_dir, updated_at=100.0)
    _, open_ = takes.scan_takes(job_dir, now=100.0 + TAKE_OPEN_STALE_SEC + 1)
    assert open_[0]["recoverable"] is True


def test_scan_orders_finished_takes_oldest_first(job_dir):
    _finished(job_dir, TAKE_B, created_at=5.0)
    _finished(job_dir, TAKE, created_at=9.0)
    finished, _ = takes.scan_takes(job_dir, now=time.time())
    assert [s["id"] for s in finished] == [TAKE_B, TAKE]


def test_take_entry_carries_urls_and_timing():
    sidecar = json.loads(json.dumps({"id": TAKE, "track_id": TRACK, "label": "L"}))
    sidecar.update(
        created_at=2.0,
        placement_sec=1.5,
        duration_sec=3.0,
        latency={"round_trip_ms": 20.0, "source": "estimated", "user_nudge_ms": -4.0},
    )
    entry = takes.take_entry(JOB, sidecar)
    assert entry["url"] == f"/api/jobs/{JOB}/takes/{TAKE}/audio.wav"
    assert entry["peaks_url"] == f"/api/jobs/{JOB}/takes/{TAKE}/peaks"
    assert entry["placement_sec"] == 1.5
    assert entry["round_trip_ms"] == 20.0
    assert entry["latency_source"] == "estimated"
    assert entry["user_nudge_ms"] == -4.0
    assert "has_camera" not in entry


def test_placement_folds_round_trip_and_nudge():
    sidecar = {
        "timeline": {"frame0_song_sec": 10.0},
        "latency": {"round_trip_ms": 25.0, "user_nudge_ms": 5.0},
    }
    assert takes.placement_sec(sidecar) == pytest.approx(9.97)


def test_tracks_round_trip_through_the_file(job_dir):
    track = takes.make_track(TRACK, "Track 1", 0)
    takes.write_tracks(job_dir, [track])
    assert takes.read_tracks(job_dir) == [track]


def test_read_tracks_drops_malformed_entries(job_dir):
    path = job_dir / TAKES_DIRNAME / "tracks.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"v": 1, "tracks": [{"id": "bad"}, 3]}), encoding="utf-8")
    assert takes.read_tracks(job_dir) == []


def test_normalise_renumbers_and_falls_back_to_the_newest_take():
    tracks = [
        {**takes.make_track("k0000000b", "B", 5), "active_take_id": "t0000000f"},
        takes.make_track(TRACK, "A", 1),
    ]
    finished = [
        {"id": TAKE, "track_id": "k0000000b", "created_at": 1.0},
        {"id": TAKE_B, "track_id": "k0000000b", "created_at": 2.0},
    ]
    out = takes.normalise_tracks(tracks, finished)
    assert [(t["id"], t["order"]) for t in out] == [(TRACK, 0), ("k0000000b", 1)]
    assert out[0]["active_take_id"] is None
    assert out[1]["active_take_id"] == TAKE_B


def test_take_and_track_ids_are_lanes_and_stems_are_not():
    assert takes_lanes.is_take_lane(TAKE)
    assert takes_lanes.is_take_lane(TRACK)
    assert not takes_lanes.is_take_lane("vocals")
    assert not takes_lanes.has_take_lane(["vocals", "drums"])
    assert takes_lanes.has_take_lane(["vocals", TRACK])


def test_track_lane_resolves_to_its_active_take(job_dir):
    folder = _finished(job_dir)
    takes.write_tracks(job_dir, [{**takes.make_track(TRACK, "A", 0), "active_take_id": TAKE}])
    expected = takes_lanes.TakeLane(TAKE, (folder / TAKE_WAV_FILE).resolve())
    assert takes_lanes.resolve_take_lane(job_dir, TRACK) == expected
    assert takes_lanes.resolve_take_lane(job_dir, TAKE) == expected


def test_lane_without_a_finished_take_resolves_to_none(job_dir):
    _open(job_dir)
    takes.write_tracks(job_dir, [takes.make_track(TRACK, "A", 0)])
    assert takes_lanes.resolve_take_lane(job_dir, TAKE) is None
    assert takes_lanes.resolve_take_lane(job_dir, TRACK) is None
    assert takes_lanes.resolve_take_lane(job_dir, "vocals") is None


def test_lane_versions_change_when_the_take_is_re_rendered(job_dir):
    folder = _finished(job_dir)
    before = takes_lanes.take_lane_versions(job_dir, ["vocals", TAKE])
    (folder / TAKE_WAV_FILE).write_bytes(b"RIFFlonger")
    after = takes_lanes.take_lane_versions(job_dir, ["vocals", TAKE])
    assert len(before) == 1 and before != after
    assert takes_lanes.take_lane_versions(job_dir, ["vocals"]) == []


def test_lane_label_is_the_take_label_or_the_track_name(job_dir):
    _finished(job_dir)
    takes.write_tracks(job_dir, [takes.make_track(TRACK, "Lead vox", 0)])
    assert takes_lanes.take_lane_label(job_dir, TAKE) == "Take 1"
    assert takes_lanes.take_lane_label(job_dir, TRACK) == "Lead vox"
    assert takes_lanes.take_lane_label(job_dir, "k0000000f") is None
    assert takes_lanes.take_lane_label(job_dir, "vocals") is None


def test_limiter_only_when_a_take_lane_is_mixed():
    assert takes_lanes.limiter_filter(["vocals"]) == ""
    chain = takes_lanes.limiter_filter(["vocals", TAKE])
    assert chain.startswith(",alimiter=limit=0.891251")
    assert "level=disabled" in chain and "latency=1" in chain
