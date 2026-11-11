from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
from pathlib import Path

from app.core.config import DEMUCS_MODEL, JOB_ID_RE
from app.core.folder_rebuild import migrate_song_folders, stopped_from_source
from app.core.folder_rebuild import recover_done_job as _recover_done_job
from app.core.models import Job
from app.core.registry_records import keep_bad_records, read_record, record_id
from app.core.song_folder import (
    SAVED_FIELDS,
    own_entries,
    remove_empty_failed_root,
    write_text_atomic,
)

logger = logging.getLogger("stemdeck.registry")

REGISTRY_VERSION = 2

_jobs: dict[str, Job] = {}
# Active subprocesses keyed by job_id (currently only Demucs). Lets
# POST /cancel terminate the running process from the API thread instead
# of waiting for the pipeline thread to notice the cancel flag.
_procs: dict[str, subprocess.Popen] = {}
_lock = threading.Lock()
# Orders registry.json saves (see persist). Taken before _lock, never inside it.
_write_lock = threading.Lock()
_REGISTRY_FILE = "registry.json"
_TERMINAL = {"done"}
# Jobs that were queued or mid-flight when the process died. They are persisted
# too (so a queue left running survives a restart) but restored as "queued" and
# handed back to the queue -- see restore(). _TERMINAL stays narrow because
# restore() and _recover_done_job() both mean "finished successfully" by it.
_RESUMABLE = {"queued", "processing", "downloading", "analyzing", "separating"}
# Halted from the Trash with its files kept (#748). Persisted so a restart
# keeps it in the Trash, and never resumed: only Extract queues it again.
_STOPPED = {"stopped"}
_PERSISTED = _TERMINAL | _RESUMABLE | _STOPPED

# One resume only. A job that reliably kills the process (a demucs OOM taking
# the backend down with it) would otherwise be re-queued on every start,
# wedging the queue forever.
_MAX_RESUME_ATTEMPTS = 1


# Ids restore() wants re-queued, drained once by the app lifespan.
_pending_resume: list[str] = []

# Job ids the user deleted. Orphan recovery in restore() adopts any job-shaped
# directory it finds, which is what resurrected tracks whose files failed to
# delete (#521). A directory that outlived its delete must not come back, and
# the client-side tombstone cannot be relied on for that -- "Reset app data"
# wipes it. Persisted with the registry; see _prune_deleted for why it stays
# small.
_deleted: set[str] = set()


def register(job: Job) -> Job:
    with _lock:
        _jobs[job.id] = job
    return job


def is_upload(job: Job) -> bool:
    """Uploads are the jobs that occupy disk while they wait."""
    return (job.source_url or "").startswith("local:")


def pending_count(*, uploads: bool) -> int:
    """How many jobs of one kind are waiting for their turn."""
    with _lock:
        return sum(1 for j in _jobs.values() if j.status == "queued" and is_upload(j) == uploads)


def requeue_if_capacity(job: Job, job_dir: Path, max_pending: int) -> bool:
    """Reset a stopped job and count it as waiting, if its kind has room.

    The same per-kind limit as a new import, checked and applied under one lock
    so two Extract presses cannot both squeeze into the last slot (#748)."""
    uploads = is_upload(job)
    with _lock:
        pending = sum(1 for j in _jobs.values() if j.status == "queued" and is_upload(j) == uploads)
        if pending >= max_pending:
            return False
        # Claims the slot. The file work in reset_for_rerun stays outside the
        # lock; the job is not in the queue until the caller enqueues it.
        job.status = "queued"
    reset_for_rerun(job, job_dir)
    return True


def register_if_capacity(job: Job, max_pending: int) -> bool:
    """Atomically check pending count and register if under capacity.
    Returns True if registered, False if the queue is full.

    Capacity is counted per kind: a waiting upload holds its source file on
    disk, a waiting URL holds nothing, so a backlog of one must not block the
    other."""
    uploads = is_upload(job)
    with _lock:
        pending = sum(1 for j in _jobs.values() if j.status == "queued" and is_upload(j) == uploads)
        if pending >= max_pending:
            return False
        _jobs[job.id] = job
    return True


def get(job_id: str) -> Job | None:
    with _lock:
        return _jobs.get(job_id)


def remove(job_id: str) -> None:
    with _lock:
        _jobs.pop(job_id, None)
        _procs.pop(job_id, None)


def set_trashed(job_id: str, trashed: bool) -> Job | None:
    """Move a job to the Trash, or take it back out.

    Not a delete: the stems stay on disk and the job stays in the registry, so
    restoring is free and the user's audio is never destroyed by a tap. Only
    emptying the Trash calls DELETE, which is what actually removes files.
    """
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        job.trashed_at = time.time() if trashed else None
        return job


def set_favorite(job_id: str, favorite: bool) -> Job | None:
    """Mark a job as a favourite, or take it back out (#734)."""
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return None
        job.favorite = favorite
        return job


def all_jobs() -> dict[str, Job]:
    """Return a snapshot of the registry for sweep / cleanup."""
    with _lock:
        return dict(_jobs)


def _migrate(data: dict) -> dict:
    """Upgrade registry JSON to REGISTRY_VERSION incrementally.
    Each block transforms v(n) → v(n+1) so older snapshots always catch up."""
    version = data.get("version", 0)
    if not isinstance(version, int):
        # Read as the oldest, so every step runs and the records still load.
        version = 0
    if version < 1:
        # v0 → v1: version field was absent; no structural change needed.
        data["version"] = 1
        version = 1
    if version < 2:
        # v1 -> v2: nothing changes in this file. _load_registry copies each
        # song's SAVED_FIELDS into its metadata.json once.
        data["version"] = 2
        version = 2
    # Future migrations go here as `if version < N:` blocks.
    return data


def registry_path(jobs_dir: Path) -> Path:
    return jobs_dir / _REGISTRY_FILE


def mark_deleted(job_id: str) -> None:
    """Record that the user deleted this job, so restore() will not re-adopt
    its directory if the files outlived the delete."""
    with _lock:
        _deleted.add(job_id)


def is_deleted(job_id: str) -> bool:
    """True if the user deleted this job and its directory may still be on
    disk, which is what lets a failed delete be retried."""
    with _lock:
        return job_id in _deleted


def _prune_deleted(jobs_dir: Path) -> None:
    """Forget deletion records whose directory is finally gone.

    A record only has to outlive the directory it refers to, so this keeps the
    set naturally bounded instead of growing for the life of the install.
    Caller must not hold _lock. The disk checks run outside it."""
    with _lock:
        recorded = set(_deleted)
    stale = {job_id for job_id in recorded if not (jobs_dir / job_id).exists()}
    with _lock:
        _deleted.difference_update(stale)


def persist(jobs_dir: Path) -> None:
    """Save the registry. Blocking: async callers run it in a thread. Only the
    snapshot holds _lock, so get() never waits on the disk (upstream PR 896)."""
    try:
        jobs_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.warning("cannot create jobs dir %s; skipping persist", jobs_dir, exc_info=True)
        return
    path = registry_path(jobs_dir)
    _prune_deleted(jobs_dir)
    with _write_lock:
        with _lock:
            records = [
                job.to_record()
                for job in sorted(_jobs.values(), key=lambda item: item.created_at)
                if job.status in _PERSISTED
            ]
            deleted = sorted(_deleted)
        body = {"version": REGISTRY_VERSION, "jobs": records, "deleted": deleted}
        try:
            write_text_atomic(path, json.dumps(body, indent=2) + "\n")
        except OSError:
            logger.warning("could not persist registry to %s", path, exc_info=True)


def restore(jobs_dir: Path) -> None:
    """Load persisted jobs and recover completed orphan jobs from disk."""
    jobs_dir.mkdir(parents=True, exist_ok=True)
    path = registry_path(jobs_dir)
    changed = legacy = False
    if path.is_file():
        try:
            changed, legacy = _load_registry(path, jobs_dir)
        except Exception:
            # Broad on purpose. restore() runs at import time, so anything that
            # escapes here stops the backend booting with no way for a user to
            # recover short of deleting the file by hand. A registry.json that
            # is valid JSON but not an object (a top-level list, null, a bare
            # string) used to do exactly that: _migrate calls data.get() and
            # raises AttributeError, which the old tuple did not name (#520).
            logger.warning("failed to load registry from %s", path, exc_info=True)

    # Orphan recovery, and the persist that follows it, were outside the guard
    # above -- an unreadable jobs_dir or a failed write was fatal at startup for
    # the same reason.
    try:
        if _adopt_orphans(jobs_dir, legacy) or changed:
            persist(jobs_dir)
    except Exception:
        logger.warning("failed to recover jobs from %s", jobs_dir, exc_info=True)


def _load_registry(path: Path, jobs_dir: Path) -> tuple[bool, bool]:
    """Read registry.json into the registry, one record at a time. Whether the
    file on disk must be rewritten, and whether it was a version 1 library."""
    data = json.loads(path.read_text(encoding="utf-8"))
    version = data.get("version") if isinstance(data, dict) else None
    legacy = not isinstance(version, int) or version < 2
    data = _migrate(data)
    recorded = data.get("deleted")
    if isinstance(recorded, list):
        with _lock:
            _deleted.update(str(job_id) for job_id in recorded)
    to_add: dict[str, Job] = {}
    resume: list[Job] = []
    changed = _load_records(data.get("jobs", []), path, jobs_dir, to_add, resume, legacy)
    if legacy and migrate_song_folders(to_add.values(), jobs_dir):
        changed = True
    with _lock:
        _jobs.update(to_add)
    # The user's order first, then oldest first: queue_position is rewritten
    # whenever the queue changes, and defaults to 0 in older records.
    _pending_resume.extend(
        j.id for j in sorted(resume, key=lambda j: (j.queue_position, j.created_at))
    )
    return changed, legacy


def _load_records(
    records: object,
    path: Path,
    jobs_dir: Path,
    to_add: dict[str, Job],
    resume: list[Job],
    legacy: bool,
) -> bool:
    """Place each record; a bad one costs only itself. True when registry.json
    must be rewritten."""
    bad: list = []
    if not isinstance(records, list):
        bad, records = [records], []
    changed = False
    for record in records:
        rid = record_id(record)
        try:
            job = read_record(record, rid, to_add)
            changed = _place(job, jobs_dir, to_add, resume, legacy) or changed
        except Exception as exc:
            # Only a well-formed id reaches the log: nothing from a damaged
            # file can forge a log line.
            logger.warning("skipping registry record %s: %s", rid or "?", exc)
            bad.append(record)
    # Kept aside first: only then is registry.json rewritten without them, so
    # the next start does not set them aside again.
    return (bool(bad) and keep_bad_records(path, bad)) or changed


def _place(
    job: Job, jobs_dir: Path, to_add: dict[str, Job], resume: list[Job], legacy: bool
) -> bool:
    """Put a loaded job where restore() wants it. True when it changed in a
    way that has to reach disk."""
    # A stopped job may have no title yet: one trashed before its download
    # finished still has files and a place in the Trash.
    if (job.status in _TERMINAL and job.title) or job.status in _STOPPED:
        to_add[job.id] = job
        return False
    if job.status not in _RESUMABLE:
        return False
    recovered = _resume_or_recover(job, jobs_dir / job.id, legacy)
    if recovered is None:
        return False
    to_add[recovered.id] = recovered
    if recovered.status in _RESUMABLE:
        resume.append(recovered)
    # The bumped resume_attempts has to reach disk here. The next persist is
    # whenever the job finishes, so without this a job that kills the process
    # every time is read back with the same count on every start and retried
    # forever -- the exact loop the cap exists to stop.
    return True


def _adopt_orphans(jobs_dir: Path, legacy: bool) -> bool:
    """Rebuild the jobs registry.json has no entry for from their folders.
    True when any was adopted."""
    with _lock:
        known = set(_jobs)
        deleted = set(_deleted)
    adopted = False
    for job_dir in jobs_dir.iterdir():
        if not job_dir.is_dir() or not JOB_ID_RE.match(job_dir.name) or job_dir.name in known:
            continue
        if job_dir.name in deleted:
            # The user deleted this and its files outlived the delete.
            # Adopting it here is what brought songs back (#521).
            continue
        try:
            recovered = _recover_done_job(job_dir, legacy) or stopped_from_source(job_dir)
        except Exception:
            # One folder that cannot be read costs that song, not every folder
            # after it and the save that follows.
            logger.warning("could not rebuild %s from its folder", job_dir.name, exc_info=True)
            continue
        if recovered is not None:
            with _lock:
                _jobs[recovered.id] = recovered
            adopted = True
    return adopted


def _resume_or_recover(job: Job, job_dir: Path, legacy: bool = False) -> Job | None:
    """Decide what a job that was in flight when the process died becomes.

    Three states of the same directory need telling apart. If the stems are all
    there, the crash landed between the last stem being written and the "done"
    persist, so the work is finished and re-running it would duplicate the
    library entry. Otherwise the job goes back in the queue from the top, after
    the partial demucs output is cleared so collect() cannot mistake it for
    results. A job that has already burned its resume is failed loudly rather
    than retried forever.

    A job the user trashed before the restart is not resumed (#748). It came
    back as a Paused row in the queue, offered to Start a song that was in the
    Trash. It is stopped instead, the same end a trash before the restart now
    has, and its files stay until the Trash is emptied."""
    recovered = _recover_done_job(job_dir, legacy)
    if recovered is not None:
        # Finished after all: keep what the registry says the user chose (its
        # Trash above all, or a binned song reappears) and its pending
        # replacement, or the copy it replaces is never settled.
        for name in SAVED_FIELDS:
            setattr(recovered, name, getattr(job, name))
        recovered.replaces = job.replaces
        return recovered

    if job.trashed_at is not None:
        reset_for_rerun(job, job_dir)
        job.status = "stopped"
        job.stage_message = "Stopped"
        return job

    job.resume_attempts += 1
    if job.resume_attempts > _MAX_RESUME_ATTEMPTS:
        job.status = "error"
        job.stage_message = "Error: Interrupted"
        job.error = "Interrupted by a restart twice. Import it again to retry."
        return job

    reset_for_rerun(job, job_dir)
    return job


def reset_for_rerun(job: Job, job_dir: Path) -> None:
    """Put a job back to the start of the pipeline, its source kept.

    The partial demucs output is cleared so collect() cannot mistake it for
    results. Shared by a resume after a restart and by extracting a stopped
    job again (#748). Bumps version, so a stream watching the job sees it."""
    shutil.rmtree(job_dir / DEMUCS_MODEL, ignore_errors=True)
    job.status = "queued"
    job.stage_message = "Queued"
    job.progress = 0.0
    job.cancel_requested = False
    job.stop_requested = False
    job.error = None
    job.stems = []
    job.mix_url = None
    job.version += 1


def take_pending_resume() -> list[str]:
    """Ids to re-queue after a restart. Pops, so a resume can only fire once."""
    with _lock:
        ids = list(_pending_resume)
        _pending_resume.clear()
    return ids


def set_proc(job_id: str, proc: subprocess.Popen | None) -> None:
    with _lock:
        if proc is None:
            _procs.pop(job_id, None)
        else:
            _procs[job_id] = proc


def reset_all(jobs_dir: Path) -> list[str]:
    """Factory reset: delete StemDeck's entries in the jobs folder and clear the
    registry. The caller checks no job runs. Returns the names not removed."""
    # A save still writing its snapshot finishes first: replacing the file
    # after the loop below removed it brought the old library back.
    with _write_lock, _lock:
        known = set(_jobs) | _deleted
        _jobs.clear()
        _procs.clear()
    if not jobs_dir.is_dir():
        return []
    failed = _remove_entries(own_entries(jobs_dir, known))
    remove_empty_failed_root(jobs_dir, failed)
    skipped = [e.name for e in jobs_dir.iterdir() if e.name not in failed]
    if skipped:
        logger.info("reset left %d entries that are not StemDeck's", len(skipped))
    # A job folder still on disk (one that failed to go, or a known one left
    # alone as a link) would be adopted again on the next start (upstream issue 521).
    surviving = [name for name in failed if JOB_ID_RE.match(name)]
    surviving += [name for name in skipped if name in known]
    if surviving:
        with _lock:
            _deleted.update(surviving)
        persist(jobs_dir)
    return failed


def _remove_entries(entries: list[Path]) -> list[str]:
    """Remove each entry; the names of those that could not be removed."""
    failed: list[str] = []
    for entry in entries:
        try:
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        except OSError:
            logger.warning("reset: could not remove %s", entry, exc_info=True)
            failed.append(entry.name)
    return failed


def get_proc(job_id: str) -> subprocess.Popen | None:
    with _lock:
        return _procs.get(job_id)
