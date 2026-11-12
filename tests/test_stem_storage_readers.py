"""Every fork reader of stem audio on a song stored as MP3 (#97): the stem
routes, the zip, the song bundle, the vocal envelope, the rebuild from disk,
auto-delete and the completeness marker, transcription, the kept transcript,
and the Lead + Backing split. A WAV song with a cached download MP3 still reads
its WAV.
"""

from __future__ import annotations

import io
import json
import os
import time
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app.core import config, settings
from app.core.folder_rebuild import recover_done_job
from app.core.models import Job, JobCancelled
from app.core.registry import _jobs
from app.core.song_folder import STEMS_COMPLETE, backfill_stems_complete
from app.core.stem_files import decoded_wav
from app.pipeline import collect, stem_storage, vocal_split
from app.pipeline.lyrics_retime import _vocals_stamp, save_transcript, transcript_path
from app.pipeline.transcribe import _vocals_reason
from tests.ffmpeg_probe import skip_without_ffmpeg

SR = 44100
SECONDS = 3.0
NAMES = ("vocals", "drums", "bass")
MP3_ID = "abcdef970101"
WAV_ID = "abcdef970102"


def _tone(seed: int) -> np.ndarray:
    t = np.arange(int(SR * SECONDS)) / SR
    x = 0.2 * np.sin(2 * np.pi * (220 + 55 * seed) * t)
    return np.column_stack([x, x])


def _wav_song(job_id: str) -> Job:
    job = Job(id=job_id, status="done", title="Readers", duration_sec=SECONDS)
    job_dir = config.JOBS_DIR / job_id
    stems = job_dir / "stems"
    stems.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(NAMES):
        sf.write(stems / f"{name}.wav", _tone(i), SR, subtype="PCM_16")
        job.stems.append({"name": name, "url": f"/api/jobs/{job_id}/stems/{name}.wav"})
    (job_dir / "metadata.json").write_text(json.dumps({"title": "Readers"}), encoding="utf-8")
    _jobs[job.id] = job
    return job


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("STEMDECK_STEM_FORMAT", raising=False)
    monkeypatch.delenv("STEMDECK_STEM_MP3_KBPS", raising=False)
    _jobs.clear()
    yield
    _jobs.clear()


@pytest.fixture
def mp3_song() -> Job:
    skip_without_ffmpeg()
    job = _wav_song(MP3_ID)
    settings.set_stem_storage("mp3", 128)
    stem_storage.store_stems(job, config.JOBS_DIR / job.id)
    assert job.stem_format == "mp3"
    return job


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


def _stems(job: Job) -> Path:
    return config.JOBS_DIR / job.id / "stems"


# ── Routes ──


@pytest.mark.parametrize("ext", ["wav", "mp3"])
def test_both_stem_urls_serve_the_stored_mp3(client, mp3_song, ext):
    r = client.get(f"/api/jobs/{mp3_song.id}/stems/vocals.{ext}")
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.content == (_stems(mp3_song) / "vocals.mp3").read_bytes()
    assert sorted(p.name for p in _stems(mp3_song).iterdir() if p.suffix == ".mp3") == [
        "bass.mp3",
        "drums.mp3",
        "vocals.mp3",
    ]


def test_wav_route_names_the_download_mp3(client, mp3_song):
    r = client.get(f"/api/jobs/{mp3_song.id}/stems/vocals.wav")
    assert ".mp3" in r.headers["content-disposition"]


def test_a_wav_song_with_a_cached_download_mp3_still_plays_its_wav(client):
    job = _wav_song(WAV_ID)
    (_stems(job) / "vocals.mp3").write_bytes(b"cached download")
    r = client.get(f"/api/jobs/{job.id}/stems/vocals.wav")
    assert r.headers["content-type"] == "audio/wav"
    assert r.content == (_stems(job) / "vocals.wav").read_bytes()


def test_mp3_zip_of_an_mp3_song_holds_the_stored_files(client, mp3_song):
    r = client.get(f"/api/jobs/{mp3_song.id}/stems/all.zip", params={"format": "mp3"})
    assert r.status_code == 200
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        for name in NAMES:
            member = next(n for n in zf.namelist() if n.endswith(f"{name}.mp3"))
            assert zf.read(member) == (_stems(mp3_song) / f"{name}.mp3").read_bytes()


def test_wav_zip_of_an_mp3_song_holds_whole_wavs(client, mp3_song):
    r = client.get(f"/api/jobs/{mp3_song.id}/stems/all.zip", params={"format": "wav"})
    assert r.status_code == 200
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        member = next(n for n in zf.namelist() if n.endswith("vocals.wav"))
        assert sf.info(io.BytesIO(zf.read(member))).frames == int(SR * SECONDS)


def test_bundle_of_an_mp3_song_keeps_the_format(client, mp3_song):
    r = client.get(f"/api/jobs/{mp3_song.id}/bundle.zip")
    assert r.status_code == 200
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        manifest = json.loads(zf.read("manifest.json"))
        assert manifest["sample_rate"] == SR
        for entry in manifest["stems"]:
            assert entry["file"] == f"stems/{entry['name']}.flac"
            flac = sf.info(io.BytesIO(zf.read(entry["file"])))
            assert entry["frames"] == flac.frames == int(SR * SECONDS)


def test_vocal_envelope_from_an_mp3_stem(client, mp3_song):
    r = client.get(f"/api/jobs/{mp3_song.id}/vocal-envelope")
    assert r.status_code == 200


# ── Rebuild, auto-delete, marker ──


def test_a_rebuilt_mp3_song_points_at_its_mp3s(mp3_song):
    job_dir = config.JOBS_DIR / mp3_song.id
    (job_dir / "metadata.json").write_text(
        json.dumps({"title": "Readers", "stem_format": "mp3", "stem_mp3_kbps": 128}),
        encoding="utf-8",
    )
    (_stems(mp3_song) / STEMS_COMPLETE).write_text("", encoding="utf-8")
    job = recover_done_job(job_dir)
    assert job is not None
    assert [s["url"] for s in job.stems] == [
        f"/api/jobs/{mp3_song.id}/stems/{n}.mp3" for n in NAMES
    ]
    assert (job.stem_format, job.stem_mp3_kbps) == ("mp3", 128)


def test_auto_delete_keeps_an_unregistered_mp3_only_song(mp3_song):
    job_dir = config.JOBS_DIR / mp3_song.id
    _jobs.clear()
    old = time.time() - 10 * 86400
    os.utime(job_dir, (old, old))
    collect.sweep_old_jobs(config.JOBS_DIR, ttl_seconds=1)
    assert (_stems(mp3_song) / "vocals.mp3").is_file()


def test_the_completion_marker_is_backfilled_for_an_mp3_only_song(mp3_song):
    job_dir = config.JOBS_DIR / mp3_song.id
    backfill_stems_complete(job_dir)
    assert (_stems(mp3_song) / STEMS_COMPLETE).is_file()


# ── Lyrics ──


def test_transcription_finds_the_mp3_vocals(mp3_song):
    assert _vocals_reason(mp3_song, config.JOBS_DIR / mp3_song.id) != "no vocals stem"


def test_a_transcript_heard_from_the_wav_stays_valid_after_storage():
    skip_without_ffmpeg()
    job = _wav_song(MP3_ID)
    job_dir = config.JOBS_DIR / job.id
    save_transcript(job_dir, words=[{"start": 0.0, "end": 0.5, "text": "la"}])
    settings.set_stem_storage("mp3", 128)
    stem_storage.store_stems(job, job_dir)
    kept = json.loads(transcript_path(job_dir).read_text(encoding="utf-8"))
    assert kept["vocals"] == _vocals_stamp(job_dir)
    assert kept["vocals"][0] == (_stems(job) / "vocals.mp3").stat().st_size


# ── Lead + Backing split ──


def test_decoded_wav_is_the_same_length_and_removed_after(mp3_song, tmp_path):
    with decoded_wav(_stems(mp3_song) / "vocals.mp3", tmp_path) as wav:
        assert wav.suffix == ".wav"
        assert sf.info(str(wav)).frames == int(SR * SECONDS)
    assert not wav.exists()


def _write_pair(work: Path) -> None:
    for i, name in enumerate(config.EXTRA_STEM_NAMES):
        sf.write(work / f"{name}.wav", _tone(i), SR, subtype="PCM_16")


def _fake_split(job, vocals_path, work, *, cancelled, report):
    _write_pair(work)


def test_the_split_reads_a_wav_and_stores_the_pair_like_the_song(mp3_song, monkeypatch):
    heard: list[str] = []

    def fake_split(job, vocals_path, work, *, cancelled, report):
        heard.append(vocals_path.suffix)
        _write_pair(work)

    monkeypatch.setattr(vocal_split, "_split_into", fake_split)
    vocal_split.split_now(mp3_song, _stems(mp3_song), cancelled=lambda: False, report=print)
    assert heard == [".wav"]
    assert mp3_song.vocal_split == "done"
    for name in config.EXTRA_STEM_NAMES:
        assert (_stems(mp3_song) / f"{name}.mp3").is_file()
        assert not (_stems(mp3_song) / f"{name}.wav").exists()
    urls = {s["name"]: s["url"] for s in mp3_song.stems}
    assert urls["lead_vocals"].endswith("/lead_vocals.mp3")
    assert not any(p.name.startswith(".") for p in _stems(mp3_song).iterdir())


def test_a_split_cancelled_while_compressing_leaves_no_pair(mp3_song, monkeypatch):
    encoded: list[Path] = []
    real_encode = stem_storage.encode_mp3

    def encode_and_count(job, src, dest, kbps):
        real_encode(job, src, dest, kbps)
        encoded.append(src)

    monkeypatch.setattr(vocal_split, "_split_into", _fake_split)
    monkeypatch.setattr(stem_storage, "encode_mp3", encode_and_count)
    with pytest.raises(JobCancelled):
        vocal_split.split_now(
            mp3_song,
            _stems(mp3_song),
            cancelled=lambda: bool(encoded),
            report=print,
        )
    assert mp3_song.vocal_split == "cancelled"
    assert len(encoded) == 1
    names = [p.name for p in _stems(mp3_song).iterdir()]
    assert not [n for n in names if any(pair in n for pair in config.EXTRA_STEM_NAMES)]
