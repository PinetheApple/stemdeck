from __future__ import annotations

import logging
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core import setlists
from app.core.models import Job
from app.core.registry import _jobs
from app.pipeline.collect import sweep_old_jobs


@pytest.fixture(autouse=True)
def _isolate_registry():
    _jobs.clear()
    yield
    _jobs.clear()


def _mkdir(jobs_dir: Path, name: str) -> Path:
    d = jobs_dir / name
    d.mkdir(parents=True)
    (d / "marker").write_bytes(b"x")
    return d


def test_skip_active_job_even_if_old(tmp_path: Path):
    """An active (non-terminal) job's directory must never be swept,
    even if its created_at predates the TTL cutoff."""
    d = _mkdir(tmp_path, "abcdefabcdef")
    job = Job(id="abcdefabcdef")
    job.status = "separating"
    job.created_at = time.time() - 999_999  # ancient
    _jobs[job.id] = job

    with patch("app.pipeline.collect.JOB_TTL_SECONDS", 60):
        sweep_old_jobs(tmp_path)

    assert d.is_dir()
    assert job.id in _jobs


def test_sweeps_terminal_old_job(tmp_path: Path):
    d = _mkdir(tmp_path, "abcdefabcdee")
    job = Job(id="abcdefabcdee")
    job.status = "done"
    job.created_at = time.time() - 999_999
    _jobs[job.id] = job

    with patch("app.pipeline.collect.JOB_TTL_SECONDS", 60):
        sweep_old_jobs(tmp_path)

    assert not d.exists()
    assert job.id not in _jobs


def _old_done_job(jobs_dir: Path, job_id: str) -> tuple[Path, Job]:
    d = _mkdir(jobs_dir, job_id)
    job = Job(id=job_id, status="done")
    job.created_at = time.time() - 999_999
    _jobs[job.id] = job
    return d, job


def test_keeps_an_old_favourite(tmp_path: Path):
    kept_dir, favourite = _old_done_job(tmp_path, "abcdefabcd01")
    favourite.favorite = True
    swept_dir, ordinary = _old_done_job(tmp_path, "abcdefabcd02")

    sweep_old_jobs(tmp_path, ttl_seconds=60)

    assert kept_dir.is_dir() and favourite.id in _jobs
    assert not swept_dir.exists() and ordinary.id not in _jobs


def test_keeps_an_old_song_that_is_in_a_setlist(tmp_path: Path):
    kept_dir, listed = _old_done_job(tmp_path, "abcdefabcd03")
    swept_dir, ordinary = _old_done_job(tmp_path, "abcdefabcd04")
    setlists.create(tmp_path, "Friday gig", [listed.id])

    sweep_old_jobs(tmp_path, ttl_seconds=60)

    assert kept_dir.is_dir() and listed.id in _jobs
    assert not swept_dir.exists() and ordinary.id not in _jobs
    assert setlists.list_all(tmp_path)[0]["song_ids"] == [listed.id]


def test_an_unreadable_setlists_file_stops_the_sweep(tmp_path: Path, caplog):
    kept_dir, job = _old_done_job(tmp_path, "abcdefabcd05")
    setlists.setlists_path(tmp_path).write_text("{not json", encoding="utf-8")

    with caplog.at_level(logging.WARNING, logger="stemdeck.collect"):
        sweep_old_jobs(tmp_path, ttl_seconds=60)

    assert kept_dir.is_dir() and job.id in _jobs
    assert any(r.name == "stemdeck.collect" for r in caplog.records)


# ── a stopped song and a song with work running are never swept (upstream PR 862, 998) ──


def _old_stopped_upload(jobs_dir: Path, job_id: str, **fields) -> tuple[Job, Path]:
    d = _mkdir(jobs_dir, job_id)
    source = d / "source.mp3"
    source.write_bytes(b"ID3")
    job = Job(id=job_id, status="stopped", source_url="local:Song", **fields)
    job.created_at = time.time() - 999_999
    _jobs[job.id] = job
    return job, source


@pytest.mark.parametrize("trashed_at", [None, 1.0], ids=["library", "trash"])
def test_old_stopped_song_survives_the_sweep(tmp_path: Path, trashed_at):
    job, source = _old_stopped_upload(tmp_path, "cccccccccc01", trashed_at=trashed_at)

    sweep_old_jobs(tmp_path, ttl_seconds=60)

    assert source.is_file()
    assert job.id in _jobs


def test_trashed_in_flight_upload_comes_back_stopped_and_is_kept(tmp_path: Path):
    """A restart turns a job trashed mid-separation into a stopped song (upstream issue 748);
    the first sweep after that start must not take it."""
    from app.core.registry import persist, restore, take_pending_resume

    job_id = "cccccccccc02"
    job = Job(id=job_id, status="separating", source_url="local:Song", trashed_at=1.0)
    job.created_at = time.time() - 999_999
    _jobs[job_id] = job
    persist(tmp_path)
    source = tmp_path / job_id / "source.mp3"
    source.parent.mkdir()
    source.write_bytes(b"ID3")
    _jobs.clear()

    restore(tmp_path)
    assert _jobs[job_id].status == "stopped"
    assert take_pending_resume() == []

    sweep_old_jobs(tmp_path, ttl_seconds=60)

    assert source.is_file()
    assert job_id in _jobs


def _run_boards():
    from app.pipeline.lyrics_retime import RETIME_RUNS
    from app.pipeline.transcribe_on_demand import TRANSCRIBE_RUNS
    from app.pipeline.vocal_split import VOCAL_SPLIT_RUNS

    return {"split": VOCAL_SPLIT_RUNS, "timing": RETIME_RUNS, "transcription": TRANSCRIBE_RUNS}


@pytest.mark.parametrize("kind", ["split", "timing", "transcription"])
def test_old_song_with_a_run_claimed_survives(tmp_path: Path, kind: str):
    """Claimed on its board is running: a split is claimed before begin_split
    marks the job, the order POST .../vocal-split takes."""
    board = _run_boards()[kind]
    d, job = _old_done_job(tmp_path, "cccccccccc04")
    assert board.claim(job.id) is not None
    try:
        sweep_old_jobs(tmp_path, ttl_seconds=60)
    finally:
        board.forget(job.id)

    assert d.is_dir()
    assert job.id in _jobs


@pytest.mark.parametrize("kind", ["split", "timing", "transcription"])
def test_old_song_goes_once_its_work_has_ended(tmp_path: Path, kind: str):
    """The keep holds only while the work runs: an ended split or lyrics run
    leaves an ordinary old song."""
    board = _run_boards()[kind]
    d, job = _old_done_job(tmp_path, "cccccccccc05")
    run = board.claim(job.id)
    assert run is not None
    run.state = "done"
    try:
        sweep_old_jobs(tmp_path, ttl_seconds=60)
    finally:
        board.forget(job.id)

    assert not d.exists()
    assert job.id not in _jobs


def _info_with(caplog, *parts: str) -> bool:
    return any(
        r.levelno == logging.INFO and all(p in r.getMessage() for p in parts)
        for r in caplog.records
        if r.name == "stemdeck.collect"
    )


def test_each_old_song_kept_or_removed_is_logged_at_info_with_its_reason(tmp_path: Path, caplog):
    _old_stopped_upload(tmp_path, "cccccccccc06")
    _old_done_job(tmp_path, "cccccccccc07")
    fresh = Job(id="cccccccccc08", status="done", created_at=time.time())
    _mkdir(tmp_path, fresh.id)
    _jobs[fresh.id] = fresh

    with caplog.at_level(logging.INFO, logger="stemdeck.collect"):
        sweep_old_jobs(tmp_path, ttl_seconds=60)

    assert _info_with(caplog, "cccccccccc06", "stopped song")
    assert _info_with(caplog, "cccccccccc07", "older than the cutoff")
    assert not _info_with(caplog, "cccccccccc08")


def test_deletion_is_off_unless_asked_for(monkeypatch):
    """The default has to be "keep". Deleting a finished separation destroys
    work that cannot be recovered, so an install nobody configured must not do
    it. It used to be the other way round, which is how a directly-run backend
    silently emptied a user's library within a day (#459)."""
    from app.core.settings import get_auto_delete_jobs

    for env in ("STEMDECK_DESKTOP", "STEMDECK_PERSIST_LIBRARY"):
        monkeypatch.delenv(env, raising=False)
    assert get_auto_delete_jobs() is False

    # The two variables that used to be the only thing standing between a user
    # and an empty library are now redundant rather than load-bearing.
    monkeypatch.setenv("STEMDECK_DESKTOP", "1")
    assert get_auto_delete_jobs() is False
    monkeypatch.setenv("STEMDECK_PERSIST_LIBRARY", "1")
    assert get_auto_delete_jobs() is False


def test_persist_library_zero_still_opts_into_deletion(monkeypatch):
    """The one env-based way in, kept for deployments that set it deliberately
    (the Unraid template exposes it, run.sh defaults it to 1)."""
    from app.core.settings import get_auto_delete_jobs

    monkeypatch.setenv("STEMDECK_PERSIST_LIBRARY", "0")
    assert get_auto_delete_jobs() is True


def test_stored_setting_beats_the_environment(monkeypatch):
    """Retention is the user's call, not the deployment's. Unlike jobs_dir,
    where an env pin wins because a mounted volume is not the user's to move,
    how long their own work is kept is theirs to decide."""
    from app.core.settings import get_auto_delete_jobs, set_auto_delete_jobs

    monkeypatch.setenv("STEMDECK_PERSIST_LIBRARY", "0")
    set_auto_delete_jobs(False)
    assert get_auto_delete_jobs() is False

    monkeypatch.setenv("STEMDECK_PERSIST_LIBRARY", "1")
    set_auto_delete_jobs(True)
    assert get_auto_delete_jobs() is True


def _sweep_loop_calls(monkeypatch):
    """Run one pass of the sweep loop, returning what each sweep was called
    with. sweep_old_jobs now takes a TTL, so record both arguments."""
    from app import main as main_mod

    ttl_calls: list = []
    failed_calls: list = []
    monkeypatch.setattr(main_mod, "sweep_old_jobs", lambda d, ttl: ttl_calls.append((d, ttl)))
    monkeypatch.setattr(main_mod, "sweep_failed_jobs", failed_calls.append)

    async def stop_loop(_delay):
        raise RuntimeError("stop-loop")

    monkeypatch.setattr(main_mod.asyncio, "sleep", stop_loop)
    return main_mod, ttl_calls, failed_calls


@pytest.mark.asyncio
async def test_sweep_loop_keeps_jobs_but_still_expires_failures(monkeypatch):
    """With deletion off the library is untouched, but the failed-job
    quarantine still expires (#277) -- failure evidence isn't library
    content, and that half was never opt-in."""
    from app.core.settings import set_auto_delete_jobs

    set_auto_delete_jobs(False)
    main_mod, ttl_calls, failed_calls = _sweep_loop_calls(monkeypatch)

    with pytest.raises(RuntimeError, match="stop-loop"):
        await main_mod._sweep_loop()

    assert ttl_calls == []
    assert failed_calls == [main_mod.JOBS_DIR]


@pytest.mark.asyncio
async def test_sweep_loop_uses_the_configured_number_of_days(monkeypatch):
    from app.core.settings import set_auto_delete_days, set_auto_delete_jobs

    set_auto_delete_jobs(True)
    set_auto_delete_days(7)
    main_mod, ttl_calls, failed_calls = _sweep_loop_calls(monkeypatch)

    with pytest.raises(RuntimeError, match="stop-loop"):
        await main_mod._sweep_loop()

    assert ttl_calls == [(main_mod.JOBS_DIR, 7 * 86400)]
    assert failed_calls == [main_mod.JOBS_DIR]


@pytest.mark.asyncio
async def test_sweep_loop_rereads_the_setting_every_pass(monkeypatch):
    """Turning deletion on must not need a restart. The loop used to decide
    once, before its first iteration, which would have made this setting the
    only one in the panel that did nothing until relaunch."""
    from app.core.settings import set_auto_delete_jobs

    set_auto_delete_jobs(False)
    main_mod, ttl_calls, _ = _sweep_loop_calls(monkeypatch)

    passes = {"n": 0}

    async def sleep_then_enable(_delay):
        passes["n"] += 1
        if passes["n"] >= 2:
            raise RuntimeError("stop-loop")
        set_auto_delete_jobs(True)

    monkeypatch.setattr(main_mod.asyncio, "sleep", sleep_then_enable)
    with pytest.raises(RuntimeError, match="stop-loop"):
        await main_mod._sweep_loop()

    # First pass swept nothing, second one did.
    assert len(ttl_calls) == 1


def test_keeps_recent_terminal_job(tmp_path: Path):
    d = _mkdir(tmp_path, "abcdefabcded")
    job = Job(id="abcdefabcded")
    job.status = "done"
    job.created_at = time.time()  # fresh
    _jobs[job.id] = job

    with patch("app.pipeline.collect.JOB_TTL_SECONDS", 60):
        sweep_old_jobs(tmp_path)

    assert d.is_dir()
    assert job.id in _jobs


def test_orphan_dir_falls_back_to_mtime(tmp_path: Path):
    """Directories with no registry entry (e.g. left over from a prior
    server run) still get swept by mtime."""
    d = _mkdir(tmp_path, "abcdefabcdec")
    # Backdate the directory.
    old = time.time() - 999_999
    import os

    os.utime(d, (old, old))

    with patch("app.pipeline.collect.JOB_TTL_SECONDS", 60):
        sweep_old_jobs(tmp_path)

    assert not d.exists()


# ── failed-job quarantine sweep (#277) ──


def test_ttl_sweep_never_touches_failed_root(tmp_path: Path):
    """sweep_old_jobs must skip jobs/failed/ even when it looks ancient --
    the quarantine has its own, longer TTL."""
    failed = _mkdir(tmp_path / "failed", "abcdefabcdef")
    old = time.time() - 999_999
    import os

    os.utime(tmp_path / "failed", (old, old))
    os.utime(failed, (old, old))

    with patch("app.pipeline.collect.JOB_TTL_SECONDS", 60):
        sweep_old_jobs(tmp_path)

    assert failed.is_dir()


def test_sweep_failed_jobs_expires_old_keeps_fresh(tmp_path: Path):
    from app.pipeline.collect import sweep_failed_jobs

    old_dir = _mkdir(tmp_path / "failed", "abcdefabcde1")
    fresh_dir = _mkdir(tmp_path / "failed", "abcdefabcde2")
    old = time.time() - 999_999
    import os

    os.utime(old_dir, (old, old))

    with patch("app.pipeline.collect.FAILED_TTL_SECONDS", 3600):
        sweep_failed_jobs(tmp_path)

    assert not old_dir.exists()
    assert fresh_dir.is_dir()


def test_sweep_failed_jobs_noop_without_quarantine(tmp_path: Path):
    from app.pipeline.collect import sweep_failed_jobs

    sweep_failed_jobs(tmp_path)  # must not raise


def test_restore_ignores_failed_quarantine(tmp_path: Path):
    """registry.restore must not resurrect a quarantined failure as a job."""
    from app.core.registry import restore

    quarantined = tmp_path / "failed" / "abcdefabcde3"
    (quarantined / "stems").mkdir(parents=True)
    (quarantined / "error.txt").write_text("evidence", encoding="utf-8")

    restore(tmp_path)

    assert "abcdefabcde3" not in _jobs
    assert quarantined.is_dir()  # restore must not delete it either
