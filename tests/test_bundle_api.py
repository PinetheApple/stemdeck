from __future__ import annotations

import io
import json
import zipfile

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app.core.models import Job
from app.core.registry import _jobs
from tests.ffmpeg_probe import skip_without_ffmpeg

SR = 44100
FRAMES = 4410


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.api import bundle as bundle_mod
    from app.api import stems as stems_mod

    monkeypatch.setattr(bundle_mod, "JOBS_DIR", tmp_path)
    # _read_beat_grid resolves the grid through the stems module's JOBS_DIR.
    monkeypatch.setattr(stems_mod, "JOBS_DIR", tmp_path)
    from app.main import app

    return TestClient(app)


def _done_job(job_id: str, title: str | None = "My Song") -> Job:
    job = Job(id=job_id)
    job.status = "done"
    job.title = title
    _jobs[job.id] = job
    return job


def _write_stem(tmp_path, job_id: str, name: str, frames: int = FRAMES) -> None:
    stems_dir = tmp_path / job_id / "stems"
    stems_dir.mkdir(parents=True, exist_ok=True)
    tone = 0.1 * np.sin(np.linspace(0, 440 * 2 * np.pi * frames / SR, frames))
    sf.write(stems_dir / f"{name}.wav", np.column_stack([tone, tone]), SR, subtype="PCM_16")


def _write_json(path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def _bundle(client, job_id: str, params: dict | None = None) -> zipfile.ZipFile:
    r = client.get(f"/api/jobs/{job_id}/bundle.zip", params=params)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    return zipfile.ZipFile(io.BytesIO(r.content))


def test_bundle_carries_stems_and_everything_known_about_the_song(client, tmp_path):
    skip_without_ffmpeg()
    job_id = "abcdef000801"
    _done_job(job_id)
    for name in ("vocals", "drums", "bass"):
        _write_stem(tmp_path, job_id, name)
    job_dir = tmp_path / job_id
    sections = [{"id": "s1", "name": "Verse", "start": 0.0, "end": 0.1, "color": "#fff"}]
    _write_json(job_dir / "metadata.json", {"title": "My Song", "bpm": 120, "sections": sections})
    _write_json(job_dir / "lyrics.json", {"synced": "[00:00.00] la", "others": [{"plain": "x"}]})
    _write_json(job_dir / "stems" / "peaks.json", {"vocals": [[-0.1, 0.1]]})
    _write_json(job_dir / "stems" / "beats.json", {"beats": [0.0, 0.5], "bars": [], "bpm": 120})
    _write_json(
        job_dir / "stems" / "beats.user.json",
        {"beats": [0.01, 0.51], "bars": [{"beat": 0, "beats_per_bar": 4}]},
    )

    r = client.get(f"/api/jobs/{job_id}/bundle.zip")
    assert r.status_code == 200, r.text
    assert "My_Song.stemdeck.zip" in r.headers["content-disposition"]
    zf = zipfile.ZipFile(io.BytesIO(r.content))

    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["format"] == "stemdeck-song-bundle"
    assert manifest["version"] == 1
    assert manifest["job_id"] == job_id
    assert (manifest["sample_rate"], manifest["channels"]) == (SR, 2)
    assert [s["name"] for s in manifest["stems"]] == ["vocals", "drums", "bass"]
    assert all(s["frames"] == FRAMES for s in manifest["stems"])
    assert manifest["files"] == ["beats.json", "lyrics.json", "metadata.json", "peaks.json"]

    # Lossless: the FLAC decodes to exactly the frames the WAV had.
    flac, rate = sf.read(io.BytesIO(zf.read("stems/vocals.flac")))
    assert (len(flac), rate) == (FRAMES, SR)
    for info in zf.infolist():
        assert info.compress_type == zipfile.ZIP_STORED

    assert json.loads(zf.read("metadata.json"))["sections"] == sections
    grid = json.loads(zf.read("beats.json"))
    assert grid["beats"] == [0.01, 0.51], "the user's grid edits are what a player clicks to"
    assert grid["bars"] == [{"beat": 0, "beats_per_bar": 4}]
    lyrics = json.loads(zf.read("lyrics.json"))
    assert lyrics["synced"] == "[00:00.00] la"
    assert "others" not in lyrics
    assert "mix.json" not in zf.namelist()


def test_bundle_mix_keeps_only_shipped_lanes_and_never_transposes_drums(client, tmp_path):
    skip_without_ffmpeg()
    job_id = "abcdef000802"
    _done_job(job_id)
    for name in ("vocals", "drums"):
        _write_stem(tmp_path, job_id, name)

    zf = _bundle(
        client,
        job_id,
        {
            "stems": "vocals,drums,piano",
            "volumes": "1.5,1,0.5",
            "muted": "1,0,0",
            "soloed": "0,1,0",
            "pitches": "2,3,0",
        },
    )
    mix = json.loads(zf.read("mix.json"))["stems"]
    assert mix["vocals"] == {"volume": 1.5, "muted": True, "soloed": False, "pitch": 2}
    assert mix["drums"]["pitch"] == 0
    assert "piano" not in mix


def test_bundle_default_skips_the_vocal_split_and_honours_a_requested_subset(client, tmp_path):
    skip_without_ffmpeg()
    job_id = "abcdef000803"
    _done_job(job_id)
    for name in ("vocals", "lead_vocals", "backing_vocals", "bass"):
        _write_stem(tmp_path, job_id, name)

    default = json.loads(_bundle(client, job_id).read("manifest.json"))
    assert [s["name"] for s in default["stems"]] == ["vocals", "bass"]

    split = _bundle(client, job_id, {"stems": "bass,backing_vocals,lead_vocals"})
    names = [s["name"] for s in json.loads(split.read("manifest.json"))["stems"]]
    assert names == ["bass", "lead_vocals", "backing_vocals"]


def test_bundle_falls_back_to_the_job_id_when_the_title_is_unusable(client, tmp_path):
    skip_without_ffmpeg()
    job_id = "abcdef000804"
    _done_job(job_id, title="!!! ???")
    _write_stem(tmp_path, job_id, "bass")

    r = client.get(f"/api/jobs/{job_id}/bundle.zip")
    assert f"{job_id}.stemdeck.zip" in r.headers["content-disposition"]


@pytest.mark.parametrize(
    ("params", "detail"),
    [
        ({"stems": "banjo"}, "unknown stem"),
        ({"stems": "vocals,lead_vocals"}, "same signal"),
        ({"volumes": "1"}, "needs the stems"),
        ({"stems": "vocals", "volumes": "1,1"}, "same length"),
        ({"stems": "vocals", "volumes": "3"}, "out of range"),
        ({"stems": "vocals", "volumes": "1", "muted": "yes"}, "0/1"),
        ({"stems": "vocals", "volumes": "1", "pitches": "9"}, "out of range"),
    ],
)
def test_bundle_rejects_bad_requests(client, tmp_path, params, detail):
    job_id = "abcdef000805"
    _done_job(job_id)
    _write_stem(tmp_path, job_id, "vocals")

    r = client.get(f"/api/jobs/{job_id}/bundle.zip", params=params)
    assert r.status_code == 422
    assert detail in r.json()["detail"]


def test_bundle_needs_a_finished_job_with_stems(client, tmp_path):
    for bad_id in ("ABCDEF000807", "abcd-efabcdef", "abcdef00080"):
        assert client.get(f"/api/jobs/{bad_id}/bundle.zip").status_code == 404
    assert client.get("/api/jobs/abcdef000807/bundle.zip").status_code == 404

    job = _done_job("abcdef000808")
    job.status = "separating"
    _write_stem(tmp_path, job.id, "vocals")
    assert client.get(f"/api/jobs/{job.id}/bundle.zip").status_code == 404

    _done_job("abcdef000809")
    (tmp_path / "abcdef000809" / "stems").mkdir(parents=True)
    assert client.get("/api/jobs/abcdef000809/bundle.zip").status_code == 404
