"""What a killed process left half-written goes on the next start
(upstream PR 900, #88).

A mix, a Lead + Backing split, a cached MP3, a metadata write, an export render
and an all-stems zip each write to a temp name first. A force quit or a power
loss in the middle left that temp on disk for good, often hundreds of MB in a
dot-named file nobody could find.
"""

from __future__ import annotations

import asyncio
import os
import threading
import time
import uuid
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.api.stems as stems_mod
from app.core import registry as _registry
from app.core.config import CACHE_TEMP_MIN_AGE_SECONDS
from app.core.models import Job
from app.pipeline import click_render

JOB = "a1b2c3d4e5f6"
OLD = time.time() - CACHE_TEMP_MIN_AGE_SECONDS - 60


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    yield
    _registry._jobs.clear()


def _hex() -> str:
    return uuid.uuid4().hex


def _put(path: Path, *, folder: bool = False, old: bool = False) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if folder:
        path.mkdir()
        (path / "lead_vocals.wav").write_bytes(b"RIFF")
    else:
        path.write_bytes(b"data")
    if old:
        os.utime(path, (OLD, OLD))
    return path


def _song(jobs: Path) -> tuple[list[Path], list[Path]]:
    """A finished song's folder: what it keeps, and what a crash left."""
    job_dir = jobs / JOB
    stems = job_dir / "stems"
    kept = [
        _put(job_dir / "metadata.json"),
        _put(job_dir / "source.mp3"),
        _put(job_dir / "lyrics.json"),
        _put(stems / "vocals.wav"),
        _put(stems / "vocals.mp3"),
        _put(stems / "peaks.json"),
        _put(stems / "beats.json"),
        _put(stems / ".complete"),
        _put(stems / ".DS_Store"),
    ]
    left = [
        _put(job_dir / f".metadata.json.{_hex()}.tmp"),
        _put(stems / f".original.wav.{_hex()}.tmp"),
        _put(stems / f".vocals.mp3.{_hex()}.tmp"),
        _put(stems / f".vocal_split.{_hex()}.tmp", folder=True),
    ]
    return kept, left


def _caches() -> tuple[list[Path], list[Path]]:
    mixdown = stems_mod._MIXDOWN_CACHE_DIR
    click = stems_mod._CLICK_CACHE_DIR
    kept = [
        _put(mixdown / "abc123.wav", old=True),
        _put(click / "def456.wav", old=True),
        # Recent: another server sharing the cache may be writing it.
        _put(mixdown / f".render.{_hex()}.tmp.wav"),
    ]
    left = [
        _put(mixdown / f".render.{_hex()}.tmp.mp3", old=True),
        _put(mixdown / f".abc123.wav.{_hex()}.tmp.wav", old=True),
        _put(click / f".def456.wav.{_hex()}.tmp", old=True),
        _put(mixdown / ".stemdeck_zip_k3j4h5g6.zip", old=True),
        _put(mixdown / ".zipwork-a1b2c3d4", folder=True, old=True),
    ]
    return kept, left


def _start_the_app() -> None:
    from app.main import app

    with TestClient(app):
        pass


def test_startup_removes_crash_leftovers_and_nothing_else():
    jobs = stems_mod.JOBS_DIR
    song_kept, song_left = _song(jobs)
    cache_kept, cache_left = _caches()
    # Not StemDeck's: no job id, or a job id holding nothing StemDeck writes.
    foreign = [
        _put(jobs / "photos" / f".x.{_hex()}.tmp"),
        _put(jobs / "0123456789ab" / f".config.{_hex()}.tmp"),
    ]

    _start_the_app()

    assert [p for p in song_left + cache_left if p.exists()] == []
    assert [p for p in song_kept + cache_kept + foreign if not p.exists()] == []


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")
def test_the_sweep_never_follows_a_link(tmp_path: Path):
    outside = tmp_path / "outside"
    leftover = _put(outside / "stems" / f".original.wav.{_hex()}.tmp")
    _put(outside / "stems" / "vocals.wav")
    jobs = stems_mod.JOBS_DIR
    (jobs / JOB).symlink_to(outside, target_is_directory=True)
    linked_stems = jobs / "b1b2c3d4e5f6"
    _put(linked_stems / "metadata.json")
    (linked_stems / "stems").symlink_to(outside / "stems", target_is_directory=True)

    _start_the_app()

    assert leftover.exists()


async def test_a_cancelled_zip_goes_once_its_build_has_stopped(monkeypatch):
    stems = stems_mod.JOBS_DIR / JOB / "stems"
    _put(stems / "vocals.wav")
    _registry.register(Job(id=JOB, status="done", title="Song"))
    release = threading.Event()
    started = threading.Event()
    built: list[Path] = []

    def slow_build(sources, fmt, dest, prefix=""):
        built.append(Path(dest))
        started.set()
        release.wait(5)
        Path(dest).write_bytes(b"PK")

    monkeypatch.setattr(stems_mod, "_build_stems_zip", slow_build)
    request = asyncio.create_task(stems_mod.get_all_stems_zip(JOB, fmt="wav", stems=None))
    await asyncio.to_thread(started.wait, 5)
    request.cancel()
    with pytest.raises(asyncio.CancelledError):
        await request

    assert built[0].exists(), "removed while the build thread still writes it"
    release.set()
    for _ in range(100):
        if not built[0].exists():
            break
        await asyncio.sleep(0.02)
    assert not built[0].exists()
    assert built[0].parent == stems_mod._MIXDOWN_CACHE_DIR


def test_two_renders_of_one_click_never_share_a_temp(tmp_path: Path, monkeypatch):
    names: list[str] = []
    real_open = wave.open

    def recording_open(path, mode):
        names.append(Path(path).name)
        return real_open(path, mode)

    monkeypatch.setattr(click_render.wave, "open", recording_open)
    dest = tmp_path / "click" / "click.wav"
    for _ in range(2):
        click_render._render_events(dest, [(0.0, 1)], 0.5, 8000)

    assert len(set(names)) == 2
    assert all(name.startswith(".") for name in names)
    assert sorted(p.name for p in dest.parent.iterdir()) == ["click.wav"]


def test_a_failed_click_render_leaves_no_temp(tmp_path: Path, monkeypatch):
    def broken_open(path, mode):
        Path(path).write_bytes(b"RIFF")
        raise OSError("disk full")

    monkeypatch.setattr(click_render.wave, "open", broken_open)

    dest = tmp_path / "click" / "click.wav"
    with pytest.raises(OSError):
        click_render._render_events(dest, [(0.0, 1)], 0.5, 8000)

    assert list(dest.parent.iterdir()) == []
