"""A picked version and a removal, as the rest of the lyrics pipeline sees
them: neither is undone by a lookup, a rename or a re-split, and lyrics kept
again end a removal."""

from __future__ import annotations

import json
import sys

from app.core.models import Job
from app.pipeline import transcribe as tr
from app.pipeline.lyrics_lookup import (
    LYRICS_REMOVED_FILE,
    LookupAnswer,
    copy_lyrics,
    drop_if_another_song,
    keep_answer,
    lyrics_settled,
    read_lyrics,
    write_lyrics,
)

FOUND = {
    "v": 1,
    "source": "lrclib",
    "track": "Song",
    "artist": "Band",
    "album": "",
    "duration": 50.0,
    "synced": "[00:10.00] one\n[00:20.00] two",
    "plain": "",
    "instrumental": False,
    "lrclib_id": 7,
}
COVER = {**FOUND, "track": "Another Song", "artist": "Someone Else", "lrclib_id": 8}


def _job() -> Job:
    return Job(
        id="aaaaaaaaaaaa",
        status="done",
        title="Song",
        duration_sec=50.0,
        audio_tags={"artist": "Band", "title": "Song"},
    )


def _write(job_dir, name: str, data: dict) -> None:
    (job_dir / name).write_text(json.dumps(data), encoding="utf-8")


def _remove(job_dir) -> None:
    _write(job_dir, LYRICS_REMOVED_FILE, {"v": 1, "removed_at": 1.0})


def test_a_lookups_answer_never_replaces_a_pick(tmp_path):
    _write(tmp_path, "lyrics.json", {**COVER, "chosen": True})
    assert keep_answer(_job(), tmp_path, LookupAnswer(FOUND, [])) is False
    assert read_lyrics(tmp_path)["lrclib_id"] == 8


def test_a_lookups_answer_never_undoes_a_removal(tmp_path):
    _remove(tmp_path)
    assert keep_answer(_job(), tmp_path, LookupAnswer(FOUND, [])) is False
    assert not (tmp_path / "lyrics.json").exists()


def test_a_removal_settles_the_track_for_good(tmp_path):
    _remove(tmp_path)
    assert lyrics_settled(tmp_path, now=1e12) is True


def test_a_picked_cover_is_not_dropped_as_another_song(tmp_path):
    _write(tmp_path, "lyrics.json", {**COVER, "chosen": True})
    assert drop_if_another_song(tmp_path, read_lyrics(tmp_path), _job()) is False
    assert read_lyrics(tmp_path)["chosen"] is True


def test_a_resplit_keeps_the_removal(tmp_path):
    src, dest = tmp_path / "src", tmp_path / "dest"
    src.mkdir()
    dest.mkdir()
    _remove(src)
    assert copy_lyrics(src, dest) is False
    assert (dest / LYRICS_REMOVED_FILE).is_file()


def test_lyrics_kept_again_end_a_removal(tmp_path):
    _remove(tmp_path)
    assert write_lyrics(_job(), tmp_path, {**FOUND, "source": "whisper"}) is True
    assert not (tmp_path / LYRICS_REMOVED_FILE).exists()


def test_an_import_never_transcribes_removed_lyrics(tmp_path, monkeypatch):
    spawned: list[str] = []

    def worker(vocals, device):
        spawned.append(device)
        return [sys.executable, "-c", "pass"]

    monkeypatch.setattr(tr, "_spawn_worker_cmd", worker)
    (tmp_path / "stems").mkdir()
    (tmp_path / "stems" / "vocals.wav").write_bytes(b"RIFF")
    job = _job()
    job.compute_device = "cuda"
    job.stem_presence = {"vocals": 79}
    assert tr.skip_reason(job, tmp_path) is None
    _remove(tmp_path)
    assert tr.transcribe_lyrics(job, tmp_path) is False
    assert spawned == []
    assert (tmp_path / LYRICS_REMOVED_FILE).is_file()
