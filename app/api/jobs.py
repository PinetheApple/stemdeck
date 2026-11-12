from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from app.core.config import (
    BEAT_TIME_DECIMALS,
    DISCOGS_LOOKUP_BUDGET_SEC,
    JOB_ID_RE,
    JOBS_DIR,
    LYRICS_LOOKUP_BUDGET_SEC,
    LYRICS_OFFSET_MAX_SEC,
    LYRICS_TIMED_MAX_CHARS,
    MAX_PENDING_UPLOAD_JOBS,
    MAX_PENDING_URL_JOBS,
    RETIME_DELETE_WAIT_SEC,
    SONG_NAME_MAX_CHARS,
    STEM_NAMES,
    TEMPO_BPM_DECIMALS,
    TEMPO_MAX_BEATS_PER_BAR,
    TEMPO_MAX_BPM,
    TEMPO_MIN_BPM,
    TIMEOUT_FETCH_TAGS,
    TIMEOUT_IDENTIFY_BACKFILL,
    TIMEOUT_LYRICS_LOOKUP,
    TIMEOUT_WORK_BACKFILL,
    UPLOAD_EXTS,
    ffprobe_executable,
)
from app.core.models import (
    FINISHED_STATUSES,
    STATUS_DONE,
    STATUS_ERROR,
    VOCAL_SPLIT_DONE,
    Job,
    VocalSplitChoice,
    _set,
    checked_name,
    clean_artist,
    settle_cancelled,
)
from app.core.registry import all_jobs as registry_all_jobs
from app.core.registry import get as registry_get
from app.core.registry import get_proc as registry_get_proc
from app.core.registry import is_deleted as registry_is_deleted
from app.core.registry import is_upload
from app.core.registry import mark_deleted as registry_mark_deleted
from app.core.registry import pending_count as registry_pending_count
from app.core.registry import persist as registry_persist
from app.core.registry import register as registry_register
from app.core.registry import register_if_capacity as registry_register_if_capacity
from app.core.registry import remove as registry_remove
from app.core.registry import requeue_if_capacity as registry_requeue_if_capacity
from app.core.registry import set_favorite as registry_set_favorite
from app.core.registry import set_trashed as registry_set_trashed
from app.core.setlists import remove_songs as setlists_remove_songs
from app.core.setlists import replace_song as setlists_replace_song
from app.core.settings import get_auto_sections, get_discogs_token, get_max_duration_sec
from app.core.song_folder import (
    FAILED_DIR_NAME,
    copy_saved_fields,
    keep_added_time,
    metadata_lock,
    update_metadata,
)
from app.core.song_folder import write_json_atomic as _write_json_atomic
from app.core.stems_location import is_relocating
from app.pipeline import discogs, jobqueue
from app.pipeline.artist_lookup import tagged_artist_name
from app.pipeline.audio_tags import probe_tags
from app.pipeline.collect import remove_job_dir
from app.pipeline.download import InvalidYouTubeURL, fetch_audio_tags, validate_youtube_url
from app.pipeline.identify import (
    can_identify_title,
    fingerprint_key,
    identify_and_find_band,
    release_source,
)
from app.pipeline.lyrics_align import detect_offset
from app.pipeline.lyrics_choice import NotAVersion, UsersOwnWords, choose_lyrics, remove_lyrics
from app.pipeline.lyrics_lookup import (
    _TEXT_MAX_CHARS,
    USER_SOURCE,
    LyricsTooLong,
    NotTheseLyrics,
    UnusableLyrics,
    build_query,
    candidates_path,
    copy_lyrics,
    drop_if_another_song,
    find_lyrics,
    forget_names,
    forget_removal,
    keep_answer,
    kept_lyrics_belong,
    lookup_lyrics,
    lyrics_path,
    lyrics_removed,
    lyrics_settled,
    original_path,
    read_candidates,
    read_lyrics,
    restore_lyrics,
    set_lyrics_offset,
    set_user_lyrics,
    set_user_synced,
)
from app.pipeline.lyrics_retime import RETIME_RUNS, RetimeFailed, RetimeRun, lyric_pairs, retime_job
from app.pipeline.lyrics_retime import saved_view as saved_retime_view
from app.pipeline.runner import FAILED_RECORD_FILE, UPLOAD_VIDEO_FILE, set_on_done
from app.pipeline.runs import FAILED, run_behind_lock, start_run_task
from app.pipeline.tempo import MODE_CONSTANT, MODE_FOLLOW
from app.pipeline.tempo_grid import (
    effective_grid,
    read_beat_edits,
    read_detected_grid,
    write_json_atomic,
)
from app.pipeline.transcribe_on_demand import TRANSCRIBE_RUNS
from app.pipeline.vocal_split import (
    VOCAL_SPLIT_RUNS,
    begin_split,
    cancel_split,
    run_split,
    split_view,
)
from app.pipeline.work_lookup import find_work, might_have_work

router = APIRouter(tags=["jobs"])
logger = logging.getLogger("stemdeck.api")

JOB_NOT_READY = "job not ready"
LYRICS_NOT_SAVED = "could not save lyrics"
LYRICS_NOT_REMOVED = "could not remove lyrics"
NO_VOCALS_STEM = "no vocals stem"
LYRICS_TIMING_RUNNING = "lyrics timing already running"
TRANSCRIPTION_RUNNING = "transcription already running"
VOCAL_SPLIT_ALREADY_RUNNING = "vocal split already running"
LYRICS_RUNNING_BLOCKS_MOVE = (
    "Lyrics are still being made. Wait for them or cancel them, then move the stems folder."
)
LYRICS_RUNNING_BLOCKS_RESET = (
    "Lyrics are still being made. Wait for them or cancel them, then reset."
)
STEMS_FOLDER_MOVING = "Restart StemDeck to finish moving your stems folder, then make the lyrics."
STEMS_FOLDER_MOVING_IMPORT = "Restart StemDeck to finish moving your stems folder before importing"
JOB_NOT_FAILED = "job has not failed"
SOURCE_FILE_GONE = "source file is gone"
RESTORE_FROM_TRASH_FIRST = "restore it from the Trash first"
RETRY_NOT_STARTED = "could not start the retry"
SOURCE_KIND_LINK = "link"
SOURCE_KIND_FILE = "file"

_MAX_UPLOAD_BYTES = 400 * 1024 * 1024  # 400 MB
_SOURCE_NAME_MAX_CHARS = 255
_WS_RE = re.compile(r"\s+")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")

# Now that imports queue instead of running immediately, a full queue is a
# capacity statement the user can act on, not a transient "try again".
_URL_QUEUE_FULL_DETAIL = (
    f"Queue is full ({MAX_PENDING_URL_JOBS} links waiting) - cancel a job or wait"
)
_UPLOAD_QUEUE_FULL_DETAIL = (
    f"Upload queue is full ({MAX_PENDING_UPLOAD_JOBS} waiting) - cancel a job or wait"
)
_FILES_NOT_DELETED_DETAIL = "Removed from the library, but its files could not be deleted."


def _sanitize_title(filename: str) -> str:
    """Strip extension, normalize whitespace, cap at 120 chars."""
    stem = Path(filename).stem
    return _WS_RE.sub(" ", stem).strip()[:120]


def _clean_source_name(filename: str) -> str:
    """The upload's file name as picked, without folders or control characters."""
    return _CONTROL_CHARS_RE.sub(" ", Path(filename).name).strip()[:_SOURCE_NAME_MAX_CHARS]


def _probe_duration(path: Path) -> float:
    """Run ffprobe to get file duration in seconds."""
    result = subprocess.run(
        [
            ffprobe_executable(),
            "-v",
            "quiet",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        # See the note in pipeline/separate.py: text=True alone decodes with the
        # Windows locale encoding and a stray byte in ffprobe's output would
        # fail the upload outright.
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr.strip()}")
    try:
        return float(result.stdout.strip())
    except ValueError as e:
        raise RuntimeError(f"ffprobe returned non-numeric duration: {result.stdout!r}") from e


def _check_file_size(file_obj: object) -> int:
    """Seek to end, return size, rewind. Operates on the SpooledTemporaryFile
    backing a starlette UploadFile — synchronous, suitable for to_thread."""
    file_obj.seek(0, 2)  # type: ignore[union-attr]
    size = file_obj.tell()  # type: ignore[union-attr]
    file_obj.seek(0)  # type: ignore[union-attr]
    return size


def _copy_to_dest(src_file: object, dest: Path) -> None:
    """Copy SpooledTemporaryFile contents to dest. Synchronous, run in thread."""
    with dest.open("wb") as out:
        shutil.copyfileobj(src_file, out)  # type: ignore[arg-type]


def _rmtree_job(job_id: str) -> bool:
    """Remove a job's directory. False means files are still on disk.

    The outcome used to be swallowed, so delete_job dropped the registry entry
    whether or not anything was actually deleted -- and restore() then adopted
    the surviving directory on the next start, which is how deleted songs came
    back (#521). The retry lives in remove_job_dir, shared with the runner's
    cancel path (#749)."""
    return remove_job_dir(JOBS_DIR / job_id)


def _job_files_missing(job: Job) -> bool:
    """True when a "done" job's stem files are gone from disk: the folder was
    deleted or moved outside the app, not just an in-flight relocation (#354),
    which is a known, temporary absence and must not flap the library."""
    if is_relocating():
        return False
    stems_dir = (JOBS_DIR / job.id / "stems").resolve()
    if not stems_dir.is_relative_to(JOBS_DIR.resolve()):
        return True
    return not stems_dir.is_dir() or not any(stems_dir.iterdir())


def _job_state(job: Job) -> dict:
    """job.to_state() with "done" downgraded to "unavailable" when the stem
    files are missing from disk - ground truth for the client, replacing the
    old approach of the frontend guessing from a 404 or a disappearance from
    the job list, neither of which caught a job whose registry entry survived
    but whose stems folder did not."""
    if job.source_format is None and (job.source_url or "").startswith("local:"):
        # Uploads made before the format was recorded still have it on disk:
        # the kept source is source.<ext>, the extension it was validated
        # against. Kept on the job once found, so the disk is asked once per
        # job rather than on every state, and persisted with it next time.
        # Uploads finished before sources were kept have nothing to find and
        # stay None, which the client shows as the plain note.
        source = _retained_source(job.id)
        if source is not None:
            job.source_format = source.suffix.lower().removeprefix(".")
    state = job.to_state()
    if job.status == "done" and _job_files_missing(job):
        state["status"] = "unavailable"
    state["source_kind"] = SOURCE_KIND_FILE if is_upload(job) else SOURCE_KIND_LINK
    state["retryable"] = job.status == STATUS_ERROR and (
        not is_upload(job) or _kept_upload_source(job.id) is not None
    )
    return state


class JobRequest(BaseModel):
    url: str
    # Subset of stems to include in the post-processing "selected mix"
    # audio file. None = all 6 (no extra mix produced; would equal the
    # original). Unknown stem names are dropped silently rather than
    # rejected, so a future model with extra stems doesn't break older
    # clients pinning the old set.
    stems: list[str] | None = None
    replaces: str | None = None


def _checked_replaces(old_id: object) -> str | None:
    """The job a new import replaces, or None when it replaces nothing.

    An id the server does not know is ignored rather than refused: the client
    may hold a song this server has already forgotten, and the import is still
    wanted. A job still waiting or running cannot be replaced, nor one another
    import is already replacing; both are a 409 with nothing created.
    """
    if old_id is None:
        return None
    if not isinstance(old_id, str) or not JOB_ID_RE.match(old_id):
        raise HTTPException(status_code=422, detail="replaces must be a job id")
    old = _known_job(old_id)
    if old is None:
        return None
    if old.status not in FINISHED_STATUSES:
        raise HTTPException(status_code=409, detail="that song is still importing")
    if any(
        job.replaces == old_id and job.status not in FINISHED_STATUSES
        for job in registry_all_jobs().values()
    ):
        raise HTTPException(status_code=409, detail="that song is already being imported again")
    return old_id


@router.post("")
async def create_job(request: Request) -> dict[str, str]:
    """Submit a YouTube URL (JSON body) or upload an audio file (multipart/form-data)
    to start a stem-separation job. Returns the new job ID.

    Either may carry ``replaces``, the id of the job it re-imports: once this
    one is done, the old copy is settled by _apply_replacement."""
    if is_relocating():
        # The stems folder just moved. This process still writes to the old one,
        # so anything accepted now would be orphaned by the restart.
        raise HTTPException(status_code=409, detail=STEMS_FOLDER_MOVING_IMPORT)
    ct = request.headers.get("content-type", "")
    if "multipart/form-data" in ct:
        return await _create_local_job(request)
    return await _create_youtube_job(request)


async def _create_youtube_job(request: Request) -> dict[str, str]:
    try:
        body = await request.json()
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid JSON: {e}") from e
    try:
        payload = JobRequest(**body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        url = validate_youtube_url(payload.url)
    except InvalidYouTubeURL as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    replaces = _checked_replaces(payload.replaces)

    selected = [s for s in payload.stems if s in STEM_NAMES] if payload.stems else list(STEM_NAMES)
    if not selected:
        selected = list(STEM_NAMES)

    job = Job(
        id=uuid.uuid4().hex[:12],
        selected_stems=selected,
        source_url=url,
        # Captured now, not when the sections stage is reached: that is the
        # last thing the pipeline does, and the toggle clears itself as soon
        # as the user opens another song.
        auto_sections=get_auto_sections(),
        replaces=replaces,
    )
    if not registry_register_if_capacity(job, MAX_PENDING_URL_JOBS):
        raise HTTPException(status_code=503, detail=_URL_QUEUE_FULL_DETAIL)
    jobqueue.enqueue(job.id)
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return {"job_id": job.id}


async def _create_local_job(request: Request) -> dict[str, str]:
    # Fast pre-check: if already at capacity, reject before touching disk.
    # The real atomic check happens in register_if_capacity after the upload.
    # Only other uploads count here: a queue full of links costs no disk and
    # must not block a file import.
    if registry_pending_count(uploads=True) >= MAX_PENDING_UPLOAD_JOBS:
        raise HTTPException(status_code=503, detail=_UPLOAD_QUEUE_FULL_DETAIL)

    # Quick pre-check on Content-Length to fail fast for obviously oversized
    # uploads without buffering the whole body first.
    cl_header = request.headers.get("content-length")
    if cl_header:
        try:
            if int(cl_header) > _MAX_UPLOAD_BYTES + 4096:
                raise HTTPException(status_code=422, detail="File exceeds 400 MB limit")
        except ValueError:
            pass

    form = await request.form()
    upload = form.get("file")
    stems_raw = form.get("stems", "[]")
    replaces = _checked_replaces(form.get("replaces"))

    if upload is None or not hasattr(upload, "filename"):
        raise HTTPException(status_code=422, detail="No file provided")

    filename: str = getattr(upload, "filename", "") or ""
    ext = Path(filename).suffix.lower()
    if ext not in UPLOAD_EXTS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported file type '{ext}': accepted formats are .mp3, .wav, .flac, .mp4, .m4a, .ogg, and .opus",
        )

    # Validate stems list from form field
    try:
        stems_list = json.loads(stems_raw)
        if not isinstance(stems_list, list):
            raise ValueError
    except (json.JSONDecodeError, ValueError):
        stems_list = []
    selected = [s for s in stems_list if s in STEM_NAMES] or list(STEM_NAMES)

    # Check actual file size (SpooledTemporaryFile is already buffered at this
    # point; seek/tell are fast and don't re-read the body).
    file_obj = upload.file  # type: ignore[union-attr]
    file_size = await asyncio.to_thread(_check_file_size, file_obj)
    if file_size == 0:
        raise HTTPException(status_code=422, detail="Uploaded file is empty")
    if file_size > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=422, detail="File exceeds 400 MB limit")

    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_DIR / job_id
    source_path = job_dir / f"source{ext}"

    job_dir.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(_copy_to_dest, file_obj, source_path)

        # Duration check before registering the job so a violation leaves no
        # registered job and no leftover directory.
        try:
            duration = await asyncio.to_thread(_probe_duration, source_path)
        except Exception as e:
            # The error names ffprobe's path and the job folder: log it, do not send it.
            logger.warning("[%s] could not read the upload's duration", job_id, exc_info=True)
            raise HTTPException(status_code=422, detail="Could not read file duration") from e

        max_duration = get_max_duration_sec()
        if duration > max_duration:
            raise HTTPException(
                status_code=422,
                detail=(f"File is {int(duration // 60)} min — limit is {max_duration // 60} min"),
            )
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    # Now, while the upload still exists: it is deleted once the pipeline is
    # done with it, and the stems carry no tags. Never fails the upload.
    audio_tags = await asyncio.to_thread(probe_tags, source_path)

    title = _sanitize_title(filename)
    local_source_url = f"local:{title}"
    job = Job(
        id=job_id,
        selected_stems=selected,
        title=title,
        duration_sec=duration,
        source_url=local_source_url,
        source_format=ext.removeprefix("."),
        source_name=_clean_source_name(filename),
        audio_tags=audio_tags,
        auto_sections=get_auto_sections(),
        replaces=replaces,
    )
    await asyncio.to_thread(keep_added_time, job, job_dir)
    if not registry_register_if_capacity(job, MAX_PENDING_UPLOAD_JOBS):
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=503, detail=_UPLOAD_QUEUE_FULL_DETAIL)
    jobqueue.enqueue(job.id)
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return {"job_id": job.id}


@router.get("")
def list_jobs(trashed: Literal["exclude", "include", "only"] = "exclude") -> list[dict]:
    """Completed jobs in the library, oldest first.

    Trashed jobs are left out by default, which is the whole point of the
    parameter: this endpoint is the phone UI's entire library, and before the
    Trash moved server-side it happily listed tracks the user had deleted on
    their desktop hours earlier.
    """
    jobs = sorted(registry_all_jobs().values(), key=lambda j: j.created_at)
    return [
        _job_state(job)
        for job in jobs
        if job.status == "done"
        and (trashed == "include" or (job.trashed_at is not None) == (trashed == "only"))
    ]


@router.post("/{job_id}/trash")
def trash_job(job_id: str) -> dict:
    """Put a job in the Trash. Reversible, and nothing on disk is touched:
    only emptying the Trash (DELETE) removes files.

    A job still waiting or running is stopped as well (#748). Trashing used to
    leave it going, hidden: the queue kept working on a song the user had
    thrown away, and a stuck one held the queue up with no way to clear it. It
    settles as "stopped", its files kept, so Restore brings it back and Extract
    can run it again. Done here rather than in each client so the phone and the
    desktop behave alike.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = _set_trashed(job_id, True)
    if job.status not in FINISHED_STATUSES:
        job.stop_requested = True
        _cancel_pipeline(job)
    else:
        _stop_runs(job, with_lyrics=False)
    registry_persist(JOBS_DIR)
    copy_saved_fields(job, JOBS_DIR / job.id)
    return {"job_id": job.id, "trashed_at": job.trashed_at}


@router.post("/{job_id}/restore")
def restore_job(job_id: str) -> dict:
    """Take a job back out of the Trash."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = _set_trashed(job_id, False)
    registry_persist(JOBS_DIR)
    copy_saved_fields(job, JOBS_DIR / job.id)
    return {"job_id": job.id, "trashed_at": job.trashed_at}


@router.post("/{job_id}/extract")
def extract_stopped_job(job_id: str) -> dict:
    """Run a stopped job again from the start, from the source it kept (#748).

    The only way a job stopped by the Trash goes back in the queue. Restore
    does not do it: taking a song out of the Trash is not a request to spend
    minutes of GPU on it. It has to be out of the Trash first, so a song the
    user threw away is never extracted by a stray request.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status != "stopped":
        raise HTTPException(status_code=409, detail="only a stopped job can be extracted again")
    if job.trashed_at is not None:
        raise HTTPException(status_code=409, detail=RESTORE_FROM_TRASH_FIRST)
    _requeue_or_refuse(job)
    registry_persist(JOBS_DIR)
    jobqueue.enqueue(job_id)
    return job.to_state()


def _requeue_or_refuse(job: Job) -> None:
    """Put a finished job back in the queue, or 503 when its kind's queue is full."""
    limit = MAX_PENDING_UPLOAD_JOBS if is_upload(job) else MAX_PENDING_URL_JOBS
    if not registry_requeue_if_capacity(job, JOBS_DIR / job.id, limit):
        raise HTTPException(
            status_code=503,
            detail=_UPLOAD_QUEUE_FULL_DETAIL if is_upload(job) else _URL_QUEUE_FULL_DETAIL,
        )


_ADOPT_LOCK = threading.Lock()
# Held by retry and delete, so a delete never removes a retry's staged source.
_RETRY_LOCK = threading.Lock()


def _failure_dir(job_id: str) -> Path:
    return JOBS_DIR / FAILED_DIR_NAME / job_id


def _set_trashed(job_id: str, trashed: bool) -> Job:
    """Trash or restore a job, a failed one in its failure record too, which is
    what it is read back from after a restart."""
    _known_job(job_id)
    job = registry_set_trashed(job_id, trashed)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    _save_trash_state(job)
    return job


def _save_trash_state(job: Job) -> None:
    """Only trashed_at is written: a failure still being kept has a record whose
    status the job does not show yet."""
    path = _failure_dir(job.id) / FAILED_RECORD_FILE
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        record["trashed_at"] = job.trashed_at
        write_json_atomic(path, record)
    except FileNotFoundError:
        return
    except (OSError, ValueError, TypeError):
        logger.warning("[%s] could not save the Trash state of a failed job", job.id)


def _known_job(job_id: str) -> Job | None:
    """The registered job, else a failed one read back from its failure record,
    unless the user deleted it."""
    job = registry_get(job_id)
    if job is not None or registry_is_deleted(job_id):
        return job
    with _ADOPT_LOCK:
        job = registry_get(job_id)
        if job is None:
            job = _read_failure_record(job_id)
            if job is not None:
                registry_register(job)
    return job


def _read_failure_record(job_id: str) -> Job | None:
    path = _failure_dir(job_id) / FAILED_RECORD_FILE
    try:
        job = Job.from_record(json.loads(path.read_text(encoding="utf-8")))
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError, AttributeError):
        logger.warning("[%s] unreadable failure record", job_id, exc_info=True)
        return None
    if job.id != job_id or job.status != STATUS_ERROR:
        return None
    return job


@router.post("/{job_id}/retry")
def retry_job(job_id: str) -> dict:
    """Run a failed import again, as the same job, from the source it kept;
    410 when an upload's kept file is gone."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    if is_relocating():
        raise HTTPException(status_code=409, detail=STEMS_FOLDER_MOVING_IMPORT)
    with _RETRY_LOCK:
        job = _known_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job not found")
        if job.status != STATUS_ERROR:
            raise HTTPException(status_code=409, detail=JOB_NOT_FAILED)
        if job.trashed_at is not None:
            raise HTTPException(status_code=409, detail=RESTORE_FROM_TRASH_FIRST)
        _requeue_failed(job, _stage_kept_upload(job))
    jobqueue.enqueue(job_id)
    return _job_state(job)


def _stage_kept_upload(job: Job) -> list[str]:
    """Move a failed upload's kept files back where the pipeline reads them.
    Returns their names, so a refused requeue can put them back."""
    if not is_upload(job):
        return []
    source = _kept_upload_source(job.id)
    if source is None:
        raise HTTPException(status_code=410, detail=SOURCE_FILE_GONE)
    names = [source.name, UPLOAD_VIDEO_FILE]
    try:
        (JOBS_DIR / job.id).mkdir(parents=True, exist_ok=True)
        _move_files(names, _failure_dir(job.id), JOBS_DIR / job.id)
    except OSError:
        logger.exception("[%s] retry could not stage the kept upload", job.id)
        raise HTTPException(status_code=500, detail=RETRY_NOT_STARTED) from None
    return names


def _requeue_failed(job: Job, staged: list[str]) -> None:
    try:
        _requeue_or_refuse(job)
    except HTTPException:
        _move_files(staged, JOBS_DIR / job.id, _failure_dir(job.id))
        raise
    _set(job, error_detail=None, error_code=None)
    # The old evidence and record go: a failure of this run writes its own, and a
    # leftover record would bring the job back as failed after a restart.
    if not remove_job_dir(_failure_dir(job.id)):
        logger.warning("[%s] old failure evidence could not be removed", job.id)
    registry_persist(JOBS_DIR)


def _move_files(names: list[str], src_dir: Path, dest_dir: Path) -> None:
    for name in names:
        if (src_dir / name).is_file():
            os.replace(src_dir / name, dest_dir / name)


class FavoriteBody(BaseModel):
    """Strict, so a string such as "false" is refused rather than read as true."""

    favorite: StrictBool


@router.put("/{job_id}/favorite")
def set_favorite(job_id: str, body: FavoriteBody) -> dict:
    """Mark a job as a favourite or take it back out (#734). Kept on the server
    so the desktop and the phone share one answer."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_set_favorite(job_id, body.favorite)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    registry_persist(JOBS_DIR)
    copy_saved_fields(job, JOBS_DIR / job.id)
    return {"job_id": job.id, "favorite": job.favorite}


class LookupBand(BaseModel):
    """The band saved on the track from the artist box, which lives in the
    studio's own store and may not be on the job yet."""

    id: str = Field(pattern=r"^Q[0-9]{1,12}$")
    name: str = Field(default="", max_length=300)
    englishName: str = Field(default="", max_length=300)  # noqa: N815 (the store's own key)


class RenameBody(BaseModel):
    """A value sets the user's own; null goes back to the detected one."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    artist: str | None = None
    band: LookupBand | None = None

    @field_validator("title", "artist")
    @classmethod
    def _check_name(cls, value: str | None) -> str | None:
        return None if value is None else checked_name(value, SONG_NAME_MAX_CHARS)

    @field_validator("band")
    @classmethod
    def _check_band(cls, value: LookupBand | None) -> LookupBand | None:
        if value is not None and clean_artist(value.model_dump()) is None:
            raise ValueError("a band needs a name")
        return value


@router.patch("/{job_id}")
def rename_job(job_id: str, body: RenameBody) -> dict:
    """Set the title and artist the library and exports show for a song.

    Stored as user_title/user_artist beside the detected values, in the
    registry and metadata.json, so the pipeline and the tag backfill can keep
    rewriting what they detect without undoing the rename.

    Lookups search by these names (Job.lookup_tags), so what was found by the
    old ones is forgotten when a name changes: the identity and the work, the
    band too when the artist changed, LRCLIB's last answer, and kept LRCLIB
    lyrics the new names disown. The next tag backfill (POST .../audio-tags)
    or Lyrics tab lookup finds them again by the new names.

    ``band`` saves the band picked in the artist box as user_band, beside the
    one found, or clears it with null. The user chose it, so nothing here
    forgets it, and saving one forgets nothing else."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    sent = body.model_fields_set
    if not sent:
        raise HTTPException(status_code=422, detail="send title, artist or band")
    fields: dict[str, object] = {
        f"user_{name}": getattr(body, name)
        for name in ("title", "artist")
        if name in sent and getattr(body, name) != getattr(job, f"user_{name}")
    }
    renamed = bool(fields)
    if "band" in sent:
        band = clean_artist(body.band.model_dump()) if body.band else None
        if band != job.user_band:
            fields["user_band"] = band
    if not fields:
        return _job_state(job)
    if renamed:
        fields.update(identity=None, work=None)
    if "user_artist" in fields:
        fields["artist"] = None
    _set(job, **fields)
    if renamed and forget_names(job, _job_dir(job_id)):
        _set(job, has_lyrics=False)
    _write_metadata_fields(job_id, fields)
    registry_persist(JOBS_DIR)
    return _job_state(job)


@router.get("/{job_id}")
def get_job(job_id: str) -> dict:
    """Get the current state of a job by ID."""
    job = _known_job(job_id) if JOB_ID_RE.match(job_id) else None
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return _job_state(job)


@router.post("/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    """Request cancellation of a running job. Idempotent for terminal jobs."""
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status in FINISHED_STATUSES:
        # Lyrics runs see their own flag, never the job's, and leave the
        # lyrics as they were; one queued behind a split stops too.
        lyrics_run = _cancel_lyrics_runs(job_id)
        # A vocal split only ever runs on a done job, so it is stopped here too:
        # it holds _pipeline_lock and would stall the import queue.
        if cancel_split(job) or lyrics_run:
            _terminate_worker(job_id)
        return job.to_state()
    _cancel_pipeline(job)
    return job.to_state()


def _cancel_lyrics_runs(job_id: str) -> bool:
    """Ask both kinds of lyrics run of ``job_id`` to stop. True when one was
    running."""
    retiming = RETIME_RUNS.cancel(job_id)
    transcribing = TRANSCRIBE_RUNS.cancel(job_id)
    return retiming or transcribing


def lyrics_run_active() -> bool:
    """Whether a lyrics timing or transcription is running on any job."""
    return RETIME_RUNS.any_running() or TRANSCRIBE_RUNS.any_running()


def _terminate_worker(job_id: str) -> None:
    proc = registry_get_proc(job_id)
    if proc is not None and proc.poll() is None:
        proc.terminate()


def _cancel_pipeline(job: Job) -> None:
    """Stop a job that is waiting or running. Shared by cancel and trash (#748).

    The caller has checked the job is not finished. A running job is only
    asked to stop here: the pipeline sees the flag, or its process dies, and
    the runner then settles it: cancelled with its directory removed, or stopped
    with its files kept when the stop came from the Trash.
    """
    job_id = job.id
    job.cancel_requested = True

    # Still waiting: the worker will never pick it up, so finalise it here.
    # Previously a queued job only honoured cancel once its turn arrived, kept
    # occupying a capacity slot until then, and a queued upload held its source
    # file (up to 400 MB) for the whole wait.
    if jobqueue.discard(job_id):
        if settle_cancelled(job):
            jobqueue.cleanup_job_dir(job_id)
        registry_persist(JOBS_DIR)
        return

    # Only the running job owns the shared demucs worker. Terminating on any
    # other id would kill someone else's separation if a stale set_proc entry
    # ever survived -- cheap insurance now that many job ids are live at once.
    if job_id == jobqueue.running_id():
        proc = registry_get_proc(job_id)
        if proc is not None and proc.poll() is None:
            proc.terminate()


class ResplitBody(BaseModel):
    """Which stems the new run should mix down to. Same shape the importer
    takes, and bounded the same way: unknown names are dropped rather than
    trusted, and an empty result falls back to every stem."""

    stems: list[str] = Field(default_factory=list, max_length=len(STEM_NAMES))


def _retained_source(job_id: str) -> Path | None:
    """The upload kept beside a finished job, if there is one.

    Only uploads have this. A link's source is deleted once its stems exist,
    because it can be fetched again; an upload's cannot, so the runner keeps
    it (see cleanup_source). Jobs finished before that change kept nothing,
    which is why absence is an ordinary answer here rather than an error.
    """
    return _source_file_in(JOBS_DIR / job_id)


def _kept_upload_source(job_id: str) -> Path | None:
    """The upload a failed job kept beside its failure evidence, for a retry."""
    return _source_file_in(_failure_dir(job_id))


def _source_file_in(directory: Path) -> Path | None:
    job_dir = directory.resolve()
    if not job_dir.is_dir() or not job_dir.is_relative_to(JOBS_DIR.resolve()):
        return None
    for candidate in sorted(job_dir.glob("source.*")):
        resolved = candidate.resolve()
        if (
            resolved.is_file()
            and resolved.suffix.lower() in UPLOAD_EXTS
            and resolved.is_relative_to(JOBS_DIR.resolve())
        ):
            return resolved
    return None


def _resplit_source_url(source_url: str | None, new_id: str) -> str:
    """A source that names the same file without colliding with it.

    A re-split stays a row beside the track it came from, and a later import
    of the original link still finds exactly one track with that source to replace.

    The marker goes on the end. It once went before the last dot, to keep an
    extension that the client read the format from, but an upload's title has
    no extension (#690): the dot it found was in the title, so "Mr. Brightside"
    became "Mr (abc123). Brightside". The format is source_format now.
    """
    return f"{source_url or 'local:track'} ({new_id[:6]})"


def _link_or_copy(src: Path, dest: Path) -> None:
    """Hard-link the source into the new job, copying only if that fails.

    A re-split of a 300 MB upload should not cost another 300 MB. Both paths
    are inside JOBS_DIR so a link is normally available; os.link raises
    EXDEV across filesystems and EPERM on some mounts, and a copy is correct
    in every case, just larger.
    """
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)


@router.post("/{job_id}/resplit")
async def resplit_job(job_id: str, body: ResplitBody) -> dict:
    """Separate a finished upload again, from the source kept beside it.

    A link-sourced track has never needed this: re-importing its URL does the
    same thing. An upload had no equivalent -- the file was handed over once,
    and the composer has nothing to submit for it -- so changing which stems
    you wanted meant finding the original file and uploading it a second time
    (#635).

    Produces a new job rather than mutating this one, which is exactly what
    re-importing a link already does. The old track keeps its stems, its
    sections and its beat grid until the person who asked for this decides
    otherwise.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(status_code=404, detail="job not found")

    source = _retained_source(job_id)
    if source is None:
        # Not a failure of this request: the track simply has nothing to
        # re-separate from. The UI offers re-import for anything with a URL.
        raise HTTPException(status_code=409, detail="no source kept for this track")

    selected = [s for s in body.stems if s in STEM_NAMES] or list(STEM_NAMES)

    new_id = uuid.uuid4().hex[:12]
    new_dir = JOBS_DIR / new_id
    new_dir.mkdir(parents=True, exist_ok=True)
    try:
        await asyncio.to_thread(_link_or_copy, source, new_dir / f"source{source.suffix}")
    except OSError:
        shutil.rmtree(new_dir, ignore_errors=True)
        logger.exception("[%s] resplit could not stage the source", job_id)
        raise HTTPException(status_code=500, detail="could not start re-split") from None

    # The same recording, so the same lyrics, and LRCLIB's "nothing" too.
    has_lyrics = await asyncio.to_thread(copy_lyrics, _job_dir(job_id), new_dir)
    new_job = Job(
        id=new_id,
        selected_stems=selected,
        title=job.title,
        user_title=job.user_title,
        user_artist=job.user_artist,
        user_band=job.user_band,
        duration_sec=job.duration_sec,
        # Still a local: source, so this job keeps its own copy and can be
        # re-split in turn -- but distinct, so the library shows it beside the
        # track it came from instead of replacing it.
        source_url=_resplit_source_url(job.source_url, new_id),
        source_format=source.suffix.lower().removeprefix("."),
        source_name=job.source_name,
        # The same recording, so the same tags, identity and band.
        audio_tags=job.audio_tags,
        identity=job.identity,
        artist=job.artist,
        work=job.work,
        has_lyrics=has_lyrics,
        auto_sections=get_auto_sections(),
        vocal_split_choice=job.vocal_split_choice,
    )
    await asyncio.to_thread(keep_added_time, new_job, new_dir)
    if not registry_register_if_capacity(new_job, MAX_PENDING_UPLOAD_JOBS):
        shutil.rmtree(new_dir, ignore_errors=True)
        raise HTTPException(status_code=503, detail=_UPLOAD_QUEUE_FULL_DETAIL)
    jobqueue.enqueue(new_job.id)
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    # source_url comes back because the client cannot derive it: it is
    # deliberately not the one it asked with.
    return {"job_id": new_job.id, "source_url": new_job.source_url}


def _vocal_split_job(job_id: str) -> Job:
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job


def _vocal_split_stems_dir(job_id: str) -> Path:
    stems_dir = (JOBS_DIR / job_id / "stems").resolve()
    if not stems_dir.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")
    return stems_dir


class VocalSplitChoiceBody(BaseModel):
    choice: VocalSplitChoice


@router.put("/{job_id}/vocal-split/choice")
def set_vocal_split_choice(job_id: str, body: VocalSplitChoiceBody) -> dict:
    """Store how the user wants this song's vocals, Combined or Lead + Backing,
    at import or later: kept with the job, so it outlives the browser tab that
    made it. Stores only; POST .../vocal-split is what splits."""
    job = _vocal_split_job(job_id)
    _set(job, vocal_split_choice=body.choice)
    registry_persist(JOBS_DIR)
    return _job_state(job)


@router.get("/{job_id}/vocal-split")
def get_vocal_split(job_id: str) -> dict:
    """Where the song's lead/backing split stands: {"state": "none" |
    "running" | "done" | "error" | "cancelled", "choice", "error"}, with
    "phase" ("queued" | "splitting") and "progress" (0 to 1) while running;
    "error" says why a failed split failed."""
    return split_view(_vocal_split_job(job_id))


@router.post("/{job_id}/vocal-split")
async def start_vocal_split(job_id: str) -> JSONResponse:
    """Split a finished song's vocals into lead and backing, in the
    background: a second model pass over the existing vocals.wav, producing
    lead_vocals.wav + backing_vocals.wav. 202 with the split's state, which
    GET .../vocal-split then follows; the job's POST .../cancel stops it. Also
    the retry after an error or a cancel. Idempotent once done: 202 with the
    existing result, the (expensive) model not re-run. 404 for a job that is
    not done, 409 with the reason when it has no vocals stem or a split is
    running."""
    job = _vocal_split_job(job_id)
    if job.status != STATUS_DONE:
        raise HTTPException(status_code=404, detail="job not found")
    if job.vocal_split == VOCAL_SPLIT_DONE:
        return JSONResponse(split_view(job), status_code=202)
    stems_dir = _vocal_split_stems_dir(job_id)
    if not await asyncio.to_thread((stems_dir / "vocals.wav").is_file):
        raise HTTPException(status_code=409, detail=NO_VOCALS_STEM)
    run = VOCAL_SPLIT_RUNS.claim(job_id)
    if run is None:
        raise HTTPException(status_code=409, detail=VOCAL_SPLIT_ALREADY_RUNNING)
    begin_split(job)
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    start_run_task(run_split(job, stems_dir, run))
    return JSONResponse(split_view(job), status_code=202)


_SECTION_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]{1,64}$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{3,8}$")


class SectionItem(BaseModel):
    id: str
    name: str
    start: float
    end: float
    color: str
    kind: (
        Literal["intro", "outro", "break", "bridge", "inst", "solo", "verse", "chorus", "part"]
        | None
    ) = None
    # Pins a section against drag and resize in the timeline editor (#573).
    # It must be declared here to exist at all: this model takes Pydantic's
    # default extra="ignore", so an undeclared field sent by the editor is
    # dropped on save and answered 200, and the flag comes back false on the
    # next load with nothing anywhere saying why.
    locked: bool = False

    @field_validator("id")
    @classmethod
    def _check_id(cls, v: str) -> str:
        if not _SECTION_ID_RE.match(v):
            raise ValueError("invalid section id")
        return v

    @field_validator("name")
    @classmethod
    def _check_name(cls, v: str) -> str:
        return v.strip()[:64] or "Section"

    @field_validator("color")
    @classmethod
    def _check_color(cls, v: str) -> str:
        if not _COLOR_RE.match(v):
            raise ValueError("invalid color")
        return v

    @field_validator("start", "end")
    @classmethod
    def _check_time(cls, v: float) -> float:
        if not (0 <= v < 86400):
            raise ValueError("time out of range")
        return round(v, 3)


# Upper bound on a section list. normalize_sections and the timeline editor
# both refuse a section shorter than 0.5 s, so the longest track StemDeck
# accepts (3600 s) cannot legitimately carry more than 7200 of them; 10000
# leaves headroom while refusing a payload sent to stall the event loop.
# Without a bound here a 33 MB body held every other request for ~4 seconds,
# and needed no valid job to do it: the body is parsed before the handler runs
# and answers 404 (#481).
_MAX_SECTIONS = 10000


class SectionsBody(BaseModel):
    sections: list[SectionItem] = Field(max_length=_MAX_SECTIONS)


@router.patch("/{job_id}/sections")
def update_sections(job_id: str, body: SectionsBody) -> dict:
    """Save named timeline sections (intro, verse, chorus, etc.) for a done job."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")

    validated = [s.model_dump(exclude_none=True) for s in body.sections]

    job_dir = (JOBS_DIR / job_id).resolve()
    if not job_dir.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")
    meta_path = job_dir / "metadata.json"

    with metadata_lock:
        meta: dict = {}
        try:
            if meta_path.is_file():
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            meta["sections"] = validated
            meta["sections_source"] = "manual"
            _write_json_atomic(meta_path, meta)
        except (OSError, json.JSONDecodeError) as exc:
            logger.exception("failed to write sections for %s: %s", job_id, exc)
            raise HTTPException(status_code=500, detail="failed to save sections") from exc

        _set(job, sections=validated, sections_source="manual")
        registry_persist(JOBS_DIR)

    return {"job_id": job_id, "sections": validated, "sections_source": "manual"}


# Jobs whose tags are being looked up right now. Only touched on the event
# loop, with no await between the check and the add, so a plain set is enough.
_TAG_LOOKUPS: set[str] = set()


def _lookup_audio_tags(job: Job) -> dict[str, str] | None:
    """Blocking: the tags a finished job's own source can still give, or None.

    An upload is asked through the source kept beside it, if one was. A link
    is asked through its metadata, and only once the stored URL has passed the
    same validator as an import: it came from the registry, not from this
    request, but nothing that fails that check is ever handed to yt-dlp.
    Raises when the fetch fails.
    """
    source_url = job.source_url or ""
    if source_url.startswith("local:"):
        source = _retained_source(job.id)
        return probe_tags(source) if source is not None else None
    try:
        url = validate_youtube_url(source_url)
    except InvalidYouTubeURL:
        return None
    return fetch_audio_tags(url)


def _write_metadata_fields(job_id: str, fields: dict[str, object]) -> None:
    """Put ``fields`` (the tags, the band) into metadata.json, if the job has
    one: restore() rebuilds a lost registry entry from this file."""
    job_dir = (JOBS_DIR / job_id).resolve()
    if job_dir.is_relative_to(JOBS_DIR.resolve()):
        update_metadata(job_dir, fields)


@router.post("/{job_id}/audio-tags")
async def refresh_audio_tags(job_id: str) -> dict:
    """Fill in a finished track's tags, and the band they name (#699), for
    tracks imported before the pipeline found them.

    Answers {"audio_tags": {...} | null, "artist": {...} | null,
    "has_lyrics": bool}. A lookup that fails or times out is "nothing found",
    not an error, and the reason is in the server log. The page asks when it
    opens a finished track it has no tags or work answer for, and stops once
    a call has been answered. A refused or failed call is asked again on the
    next page load; a 409 (the job is not done, or a lookup for it is under
    way) on the next open. The band is looked up when the tags name an
    artist and the job has no band yet, whether the tags were found just now
    or were there already, and the lyrics (lyrics.json, GET .../lyrics) when
    the job has none and anything is known to look them up by.

    Also "identity" (app/pipeline/identify.py), found here for a job that has
    none, the same way the pipeline finds it: an AcoustID fingerprint of the
    kept upload or of the stems summed, when the user set a key, else a
    MusicBrainz search by the tags, else by the title (and LRCLIB), else the
    tags. The band is then found
    through it. An added key, so older clients read the answer as before.

    And "work" (app/pipeline/work_lookup.py): the musical, film or series a
    soundtrack or cast recording is from, found here for a job that has none
    when its identity, album tag or title says it is one. Also an added key.

    A POST because it may keep what it finds: in the registry and
    metadata.json, and in lyrics.json or, when LRCLIB had none, the record of
    that ask, which keeps it from being asked again before
    LYRICS_NOT_FOUND_RETRY_SEC; a call past that rewrites the record. Only
    what the job lacked is written, so a call that finds nothing new inside
    that window writes nothing.

    Deliberately outside _pipeline_lock. This is one metadata request, and
    waiting behind a twenty-minute separation for it would leave the artist
    box empty for no reason.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    if job.status != "done":
        raise HTTPException(status_code=409, detail="job is not finished")
    job_dir = _job_dir(job_id)
    if (
        job.audio_tags
        and (job.artist or not tagged_artist_name(job.lookup_tags(job.audio_tags).get("artist")))
        and lyrics_settled(job_dir)
        and not _wants_identity(job, job.audio_tags)
        and not _wants_work(job, job.identity, job.audio_tags)
    ):
        return {
            "audio_tags": job.audio_tags,
            "artist": job.band,
            "has_lyrics": True,
            "identity": job.identity,
            "work": job.work,
        }
    if job_id in _TAG_LOOKUPS:
        raise HTTPException(status_code=409, detail="already looking up this track")

    _TAG_LOOKUPS.add(job_id)
    names = job.user_names
    try:
        tags = job.audio_tags
        if not tags:
            try:
                # A timeout abandons the wait, not the thread: yt-dlp's own
                # socket timeout ends that, and its answer is then dropped.
                tags = await asyncio.wait_for(
                    asyncio.to_thread(_lookup_audio_tags, job), timeout=TIMEOUT_FETCH_TAGS
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "[%s] audio tag lookup timed out after %ds", job_id, TIMEOUT_FETCH_TAGS
                )
                tags = None
            except Exception:
                logger.warning("[%s] audio tag lookup failed", job_id, exc_info=True)
                tags = None
        artist = None
        identity = job.identity
        # The identity when the job has none and there is something to find
        # it by (a key to fingerprint with, or an artist tag), and the band
        # through it, only for a job with none and a name to find it by: a
        # job here for its lyrics alone may have tags naming no artist.
        want_identity = _wants_identity(job, tags)
        want_band = not job.artist and bool(
            tagged_artist_name((job.lookup_tags(tags) or {}).get("artist"))
            or (identity or {}).get("artist")
            or want_identity
        )
        if want_identity or want_band:
            audio = await asyncio.to_thread(_fingerprint_audio, job) if want_identity else []
            # identify_and_find_band never raises; the wait is bounded all the
            # same, since a socket timeout is per read, not per request.
            try:
                identity, artist = await asyncio.wait_for(
                    asyncio.to_thread(
                        identify_and_find_band,
                        job,
                        audio,
                        tags=tags,
                        want_band=want_band,
                        cancelled=lambda: registry_get(job_id) is not job,
                    ),
                    timeout=TIMEOUT_IDENTIFY_BACKFILL,
                )
            except asyncio.TimeoutError:
                logger.info("[%s] identification timed out", job_id)
        work = None
        # The work behind a soundtrack, once the identity says which recording
        # this is. find_work never raises; the wait is bounded as above.
        if _wants_work(job, identity, tags):
            try:
                work = await asyncio.wait_for(
                    asyncio.to_thread(
                        find_work,
                        identity,
                        job.lookup_tags(tags),
                        title=job.display_title,
                        cancelled=lambda: registry_get(job_id) is not job,
                    ),
                    timeout=TIMEOUT_WORK_BACKFILL,
                )
            except asyncio.TimeoutError:
                logger.info("[%s] work lookup timed out", job_id)
        lyrics = None
        query = build_query(job, audio_tags=tags, band=artist, identity=identity)
        # Not asked again while LRCLIB's last "nothing" is recent.
        if query is not None and not lyrics_settled(job_dir):
            # find_lyrics never raises, and starts no request past its budget.
            try:
                lyrics = await asyncio.wait_for(
                    asyncio.to_thread(
                        find_lyrics,
                        query,
                        cancelled=lambda: registry_get(job_id) is not job,
                        fallback_title=job.display_title or "",
                    ),
                    timeout=LYRICS_LOOKUP_BUDGET_SEC + TIMEOUT_LYRICS_LOOKUP + 1,
                )
            except asyncio.TimeoutError:
                logger.info("[%s] lyrics lookup timed out", job_id)
    finally:
        _TAG_LOOKUPS.discard(job_id)

    # The track was deleted while the lookup ran.
    if registry_get(job_id) is not job:
        return {
            "audio_tags": None,
            "artist": None,
            "has_lyrics": False,
            "identity": None,
            "work": None,
        }
    if job.user_names != names:
        logger.info("[%s] renamed during the tag backfill; keeping only the tags", job_id)
        lyrics = identity = artist = work = None
    if (
        lyrics
        and not lyrics_path(job_dir).is_file()
        and await asyncio.to_thread(keep_answer, job, job_dir, lyrics)
    ):
        await asyncio.to_thread(registry_persist, JOBS_DIR)
    found: dict[str, object] = {}
    if tags and not job.audio_tags:
        found["audio_tags"] = tags
    if artist and not job.artist:
        found["artist"] = artist
    if identity and not job.identity:
        found["identity"] = identity
    if work and not job.work:
        found["work"] = work
    if found:
        _set(job, **found)
        await asyncio.to_thread(registry_persist, JOBS_DIR)
        await asyncio.to_thread(_write_metadata_fields, job_id, found)
    return {
        "audio_tags": job.audio_tags,
        "artist": job.band,
        "has_lyrics": lyrics_path(job_dir).is_file(),
        "identity": job.identity,
        "work": job.work,
    }


def _wants_identity(job: Job, tags: dict[str, str] | None) -> bool:
    """Whether the backfill should identify ``job``: it has no identity yet,
    and there is a key to fingerprint with, an artist tag to search by, or a
    title naming more than a song (a YouTube upload with no music metadata)."""
    if job.identity is not None:
        return False
    tags = job.lookup_tags(tags)
    return (
        bool(fingerprint_key(job))
        or bool(tagged_artist_name((tags or {}).get("artist")))
        or can_identify_title(tags, job.display_title)
    )


def _wants_work(job: Job, identity: dict[str, object] | None, tags: dict[str, str] | None) -> bool:
    """Whether the backfill should look for the work ``job``'s song is from:
    it has none yet, and its identity, album tag or title says it is from one."""
    return job.work is None and might_have_work(identity, job.lookup_tags(tags), job.display_title)


def _fingerprint_audio(job: Job) -> list[Path]:
    """Blocking: what to fingerprint a finished job from. The upload kept
    beside it; else its stems, which add back up to the mix (a link's
    download is deleted once they exist). Only whitelisted stem names, each
    resolved inside the job's directory."""
    source = _retained_source(job.id)
    if source is not None:
        return [source]
    stems_root = (JOBS_DIR / job.id / "stems").resolve()
    stems = []
    for name in STEM_NAMES:
        path = (stems_root / f"{name}.wav").resolve()
        if path.is_file() and path.is_relative_to(JOBS_DIR.resolve()):
            stems.append(path)
    return stems


def _job_dir(job_id: str) -> Path:
    """A job's directory, for an id that has passed JOB_ID_RE. Refused (404)
    if it would resolve outside JOBS_DIR all the same."""
    job_dir = (JOBS_DIR / job_id).resolve()
    if not job_dir.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")
    return job_dir


# One Discogs lookup per job at a time: a second request for the same job
# (the box opened twice, two tabs) waits for the first one's answer.
_DISCOGS_LOOKUPS: dict[str, asyncio.Task] = {}


@router.get("/{job_id}/artist-extra")
async def get_artist_extra(job_id: str) -> dict:
    """The Discogs profile of the band a track is by (app/pipeline/discogs.py),
    for the artist box, when Wikipedia has no article on it or leaves gaps.

    Answers {"id", "name", "real_name", "profile": [...], "members":
    {"current", "former"}, "groups", "links": [{"kind", "url"}], "releases":
    [{"year", "title"}], "url"}, or 404 when no Discogs token is set or no
    artist is confidently the track's. The token never leaves the server: the
    page asks here, and this asks Discogs.

    Outside _pipeline_lock, as the tag backfill is: a few metadata requests
    must not wait behind a separation. Bounded by DISCOGS_LOOKUP_BUDGET_SEC.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    token = get_discogs_token()
    if not token:
        raise HTTPException(status_code=404, detail="no artist details")

    task = _DISCOGS_LOOKUPS.get(job_id)
    if task is None:
        deadline = time.monotonic() + DISCOGS_LOOKUP_BUDGET_SEC

        def cancelled() -> bool:
            return registry_get(job_id) is not job or time.monotonic() > deadline

        task = asyncio.create_task(
            asyncio.to_thread(
                discogs.artist_for_track,
                job.identity,
                job.lookup_tags(job.audio_tags),
                job.band,
                token,
                cancelled=cancelled,
            )
        )
        _DISCOGS_LOOKUPS[job_id] = task
        task.add_done_callback(lambda _t: _DISCOGS_LOOKUPS.pop(job_id, None))
    try:
        # Shielded, so one caller giving up does not cancel another's answer.
        answer = await asyncio.wait_for(asyncio.shield(task), DISCOGS_LOOKUP_BUDGET_SEC + 1)
    except asyncio.TimeoutError:
        logger.info("[%s] Discogs lookup timed out", job_id)
        answer = None
    except Exception:
        logger.exception("[%s] Discogs lookup failed", job_id)
        answer = None
    if answer is None or registry_get(job_id) is not job:
        raise HTTPException(status_code=404, detail="no artist details")
    return answer


@router.get("/{job_id}/lyrics")
def get_lyrics(job_id: str) -> Response:
    """The track's lyrics, as found while it was separated (lyrics.json, see
    app/pipeline/lyrics_lookup.py), or 404 when it has none.

    A 404 may carry {"others": [...]}: the versions LRCLIB had when none was
    the length of the track (lyrics_candidates.json), for the tab to offer.
    A transcription with no others of its own is served with those. After
    the user's Remove lyrics, the 404 is _REMOVED_ANSWER instead.

    Served apart from the job's state, which carries only has_lyrics: the
    text runs to kilobytes, with every other version kept beside it, and the
    state is sent on every change to a running job.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    job_dir = _job_dir(job_id)
    jobs_root = JOBS_DIR.resolve()
    path = lyrics_path(job_dir).resolve()
    found_path = candidates_path(job_dir).resolve()
    if not path.is_relative_to(jobs_root) or not found_path.is_relative_to(jobs_root):
        raise HTTPException(status_code=404, detail="no lyrics")
    entry = read_lyrics(job_dir) if path.is_file() else None
    if entry is None and path.is_file():
        logger.warning("unreadable lyrics for %s", job_id)
    found = read_candidates(job_dir) if found_path.is_file() else None
    others = found["others"] if found else []
    # Lyrics kept before a lookup held them to the track's own song and artist
    # can be another song's: checked by that rule each time they are asked for,
    # and dropped for good when they fail it.
    others = [o for o in others if kept_lyrics_belong(o, job)]
    if entry is not None and drop_if_another_song(job_dir, entry, job):
        logger.info("[%s] dropping kept lyrics of another song", job_id)
        _set(job, has_lyrics=False)
        registry_persist(JOBS_DIR)
        entry = None
    if entry is not None:
        entry["others"] = [o for o in entry["others"] if kept_lyrics_belong(o, job)]
    headers = {"Cache-Control": "no-cache"}
    if entry is not None:
        if not entry["others"]:
            entry["others"] = others
        if entry["source"] == USER_SOURCE:
            entry["has_original"] = original_path(job_dir).is_file()
        return JSONResponse(entry, headers=headers)
    if lyrics_removed(job_dir):
        return JSONResponse(_REMOVED_ANSWER, status_code=404, headers=headers)
    if others:
        return JSONResponse(
            {"detail": "no lyrics", "others": others}, status_code=404, headers=headers
        )
    raise HTTPException(status_code=404, detail="no lyrics")


# GET .../lyrics after the user's Remove lyrics, until lyrics are kept again.
_REMOVED_ANSWER = {"detail": "lyrics removed", "removed": True, "others": []}


class LyricsLookupBody(BaseModel):
    band: LookupBand | None = None
    # Look up again: ends the user's removal, which otherwise holds the lookup back.
    again: StrictBool = False


# Jobs whose lyrics the tab is looking up now, so a second request for the
# same track waits for the first rather than asking LRCLIB twice.
_LYRICS_LOOKUPS: set[str] = set()


@router.post("/{job_id}/lyrics/lookup")
async def lookup_lyrics_route(job_id: str, body: LyricsLookupBody | None = None) -> Response:
    """Look the track's lyrics up on LRCLIB now, for the Lyrics tab (#719).

    The tab used to search LRCLIB itself, with its own copy of the rules that
    decide which version is this song by this artist and which length fits.
    The two copies had to be kept equal by hand, and when they drifted the
    same track could get lyrics at import and none in the tab. This runs the
    import's own lookup instead, keeps what it finds the way the import does,
    and answers exactly as GET .../lyrics would afterwards.

    Only ever asked when the tab is opened on a track with no lyrics, or the
    user presses Look up again: LRCLIB is never reached on its own. 502 when
    LRCLIB cannot be reached, so the tab can offer to try again; 404 with
    {"nothing_known": true} when the track says too little to look up. After
    the user's Remove lyrics, only {"again": true} asks, and ends the removal.
    """
    job, job_dir = _lyrics_job(job_id)
    if await asyncio.to_thread(lyrics_path(job_dir).is_file):
        return await asyncio.to_thread(get_lyrics, job_id)
    if body and body.again:
        await asyncio.to_thread(forget_removal, job_dir)
    elif await asyncio.to_thread(lyrics_removed, job_dir):
        return await asyncio.to_thread(get_lyrics, job_id)
    if job_id in _LYRICS_LOOKUPS:
        raise HTTPException(status_code=409, detail="already looking")
    band = body.band.model_dump() if body and body.band else None
    query = build_query(job, band=band)
    if query is None:
        return JSONResponse(
            {"detail": "nothing to look up", "others": [], "nothing_known": True}, status_code=404
        )
    _LYRICS_LOOKUPS.add(job_id)
    names = job.user_names
    try:
        answer = await asyncio.wait_for(
            asyncio.to_thread(
                lookup_lyrics,
                query,
                cancelled=lambda: registry_get(job_id) is not job,
                fallback_title=job.display_title or "",
            ),
            timeout=LYRICS_LOOKUP_BUDGET_SEC + TIMEOUT_LYRICS_LOOKUP + 1,
        )
    except asyncio.TimeoutError:
        logger.info("[%s] lyrics lookup timed out", job_id)
        raise HTTPException(status_code=502, detail="lyrics service unreachable") from None
    except Exception:
        logger.info("[%s] lyrics lookup failed", job_id, exc_info=True)
        raise HTTPException(status_code=502, detail="lyrics service unreachable") from None
    finally:
        _LYRICS_LOOKUPS.discard(job_id)
    if registry_get(job_id) is not job:
        raise HTTPException(status_code=404, detail="job not found")
    if (
        answer is not None
        and job.user_names == names
        and not lyrics_path(job_dir).is_file()
        and await asyncio.to_thread(keep_answer, job, job_dir, answer)
    ):
        await asyncio.to_thread(registry_persist, JOBS_DIR)
    try:
        return await asyncio.to_thread(get_lyrics, job_id)
    except HTTPException:
        return JSONResponse({"detail": "no lyrics", "others": []}, status_code=404)


class LyricsOffsetBody(BaseModel):
    """How many seconds later than their own timing the lyrics are shown:
    negative for earlier, 0 for their own timing again."""

    offset_sec: float = Field(
        ge=-LYRICS_OFFSET_MAX_SEC, le=LYRICS_OFFSET_MAX_SEC, allow_inf_nan=False
    )


class LyricsAlignBody(BaseModel):
    """Synced lyrics to estimate against the track's vocals without saving
    anything. Omitted for the lyrics the server keeps (lyrics.json)."""

    synced: str | None = Field(default=None, max_length=_TEXT_MAX_CHARS)


def _lyrics_job(job_id: str) -> tuple[Job, Path]:
    """The job and its directory, for a lyrics edit: 404 for a malformed or
    unknown id, or one whose lyrics.json would resolve outside JOBS_DIR."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    job_dir = _job_dir(job_id)
    if not lyrics_path(job_dir).resolve().is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="no lyrics")
    return job, job_dir


def _synced_lyrics(job_dir: Path) -> dict:
    """Blocking: the job's lyrics.json when it has synced lyrics. 404 when it
    has none, 409 when they are text only and have no timing to move."""
    entry = read_lyrics(job_dir) if lyrics_path(job_dir).is_file() else None
    if entry is None:
        raise HTTPException(status_code=404, detail="no lyrics")
    if not entry["synced"]:
        raise HTTPException(status_code=409, detail="lyrics are not synced")
    return entry


# A lyrics edit's body: an offset, or at most _TEXT_MAX_CHARS of LRC, which
# as UTF-8 runs to four bytes a character.
_LYRICS_BODY_MAX_BYTES = 4 * _TEXT_MAX_CHARS + 1024


# A manual timing's body: LYRICS_TIMED_MAX_CHARS of LRC, as UTF-8.
_TIMED_BODY_MAX_BYTES = 4 * LYRICS_TIMED_MAX_CHARS + 1024


# A version's body: its synced and plain text, its fitted timing and the
# user's own.
_CHOICE_BODY_MAX_BYTES = 3 * _LYRICS_BODY_MAX_BYTES + _TIMED_BODY_MAX_BYTES


async def _lyrics_body(
    request: Request,
    model: type[BaseModel],
    empty_ok: bool = False,
    max_bytes: int = _LYRICS_BODY_MAX_BYTES,
):
    """A lyrics edit's JSON body as ``model``: None for no body at all when
    ``empty_ok``. 413 past _LYRICS_BODY_MAX_BYTES, else 422 for anything that
    is not the model, with NaN and Infinity refused while parsing (see
    _reject_non_finite) and nothing sent back of what was submitted."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(status_code=413, detail="body too large")
    raw = await request.body()
    if len(raw) > max_bytes:
        raise HTTPException(status_code=413, detail="body too large")
    if not raw.strip() and empty_ok:
        return None
    try:
        data = json.loads(raw, parse_constant=_reject_non_finite)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail="invalid JSON body") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="expected a JSON object")
    try:
        return model(**data)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="invalid lyrics edit") from exc


@router.post("/{job_id}/lyrics/offset")
async def set_lyrics_offset_route(job_id: str, request: Request) -> dict:
    """Keep the user's alignment of the track's synced lyrics (the Lyrics
    tab's Align panel): {"offset_sec": seconds later, negative for earlier,
    0 for their own timing}. Kept beside the synced text in lyrics.json, which
    is never rewritten, and applied by the page. Answers the offset kept."""
    job, job_dir = _lyrics_job(job_id)
    body = await _lyrics_body(request, LyricsOffsetBody)
    await asyncio.to_thread(_synced_lyrics, job_dir)
    entry = await asyncio.to_thread(set_lyrics_offset, job, job_dir, body.offset_sec)
    if entry is None:
        raise HTTPException(status_code=500, detail=LYRICS_NOT_SAVED)
    return {"offset_sec": entry["offset_sec"]}


@router.post("/{job_id}/lyrics/align")
async def align_lyrics_route(job_id: str, request: Request) -> dict:
    """Estimate from the vocals stem how much later the lyrics are sung on
    this track than their stamps say, whatever timing they were saved with
    (the Align panel's Auto-detect): {"confident": bool, "offset_sec":
    seconds or null}.

    Without a body, for the lyrics the server keeps: a confident estimate is
    kept as their offset, as POST .../lyrics/offset would, and one that is
    not leaves them as they are. With {"synced": ...}: only the estimate is
    answered, and nothing is saved.

    Outside _pipeline_lock, like GET .../vocal-envelope: at most one streamed
    read of one stem, and none when its envelope is already kept."""
    job, job_dir = _lyrics_job(job_id)
    body = await _lyrics_body(request, LyricsAlignBody, empty_ok=True)
    if job.status != "done":
        raise HTTPException(status_code=409, detail="job not ready")
    stems_dir = (job_dir / "stems").resolve()
    if not stems_dir.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")
    kept_here = body is None or body.synced is None
    if kept_here:
        synced = (await asyncio.to_thread(_synced_lyrics, job_dir))["synced"]
    else:
        synced = body.synced
    try:
        shift = await asyncio.to_thread(detect_offset, synced, stems_dir)
    except Exception:
        logger.exception("lyrics alignment failed for %s", job_id)
        raise HTTPException(status_code=500, detail="could not align lyrics") from None
    if shift is None or abs(shift) > LYRICS_OFFSET_MAX_SEC:
        return {"confident": False, "offset_sec": None}
    if kept_here:
        entry = await asyncio.to_thread(set_lyrics_offset, job, job_dir, shift)
        if entry is None:
            raise HTTPException(status_code=500, detail=LYRICS_NOT_SAVED)
        shift = entry["offset_sec"]
    return {"confident": True, "offset_sec": shift}


def _retime_ready(job_dir: Path, lyrics: dict | None) -> None:
    """Blocking: 404 without lyrics (kept, or given), 409 when they have no
    lines to time (an instrumental) or there is no vocals stem to time them
    to."""
    if lyrics is None:
        lyrics = read_lyrics(job_dir) if lyrics_path(job_dir).is_file() else None
        if lyrics is None:
            raise HTTPException(status_code=404, detail="no lyrics")
    if not lyric_pairs(lyrics):
        raise HTTPException(status_code=409, detail="lyrics have no lines")
    vocals = (job_dir / "stems" / "vocals.wav").resolve()
    if not vocals.is_relative_to(JOBS_DIR.resolve()) or not vocals.is_file():
        raise HTTPException(status_code=409, detail=NO_VOCALS_STEM)


def _retime_work(
    job: Job,
    job_dir: Path,
    run: RetimeRun,
    lyrics: dict | None,
) -> Callable[[Callable[[], bool]], None]:
    def report(share: float) -> None:
        run.progress = share

    def work(cancelled: Callable[[], bool]) -> None:
        try:
            outcome = retime_job(
                job,
                job_dir,
                cancelled=cancelled,
                report=report,
                lyrics=lyrics,
            )
        except RetimeFailed as exc:
            logger.info("[%s] lyrics not timed: %s", job.id, exc)
            run.state = FAILED
            return
        run.outcome = outcome
        run.state = outcome.state

    return work


class LyricsRetimeBody(BaseModel):
    """Lyrics the browser keeps (found by the tab's own LRCLIB lookup), to
    time without saving anything. Omitted for the lyrics the server keeps."""

    synced: str | None = Field(default=None, max_length=_TEXT_MAX_CHARS)
    plain: str | None = Field(default=None, max_length=_TEXT_MAX_CHARS)


@router.post("/{job_id}/lyrics/retime")
async def start_lyrics_retime(job_id: str, request: Request) -> JSONResponse:
    """Time the track's lyrics line by line to its vocals
    (app/pipeline/lyrics_retime.py), in the background: 202 with the run's
    state, which GET .../lyrics/retime then follows.

    Without a body, the lyrics the server keeps: the result is kept in
    lyrics.json as "aligned" when it is good enough, and nothing changes
    when it is not ("unsure"). With {"synced", "plain"}, lyrics the browser
    keeps: the result comes back as "aligned" in GET's "done" answer and
    nothing is saved but the transcript.

    Runs behind the pipeline lock, after any import in progress, and takes a
    transcription of the vocals the first time (about 30 s on a GPU, a few
    minutes on a CPU; asked for here, it runs on either). One run at a time
    per track: 409 while one, or a transcription (POST .../lyrics/transcribe),
    is running. POST .../cancel stops it."""
    job, job_dir = _lyrics_job(job_id)
    body = await _lyrics_body(request, LyricsRetimeBody, empty_ok=True)
    if job.status != STATUS_DONE:
        raise HTTPException(status_code=409, detail=JOB_NOT_READY)
    lyrics = None
    if body is not None and (body.synced or body.plain):
        lyrics = {"synced": body.synced or "", "plain": body.plain or ""}
    await asyncio.to_thread(_retime_ready, job_dir, lyrics)
    if TRANSCRIBE_RUNS.running(job_id):
        raise HTTPException(status_code=409, detail=TRANSCRIPTION_RUNNING)
    if is_relocating():
        raise HTTPException(status_code=409, detail=STEMS_FOLDER_MOVING)
    run = RETIME_RUNS.claim(job_id)
    if run is None:
        raise HTTPException(status_code=409, detail=LYRICS_TIMING_RUNNING)
    start_run_task(
        run_behind_lock(
            job,
            run,
            _retime_work(job, job_dir, run, lyrics),
            "lyrics timing",
        )
    )
    return JSONResponse(run.view(), status_code=202)


@router.get("/{job_id}/lyrics/retime")
def get_lyrics_retime(job_id: str) -> dict:
    """Where the line-by-line timing of the track's lyrics stands:
    {"state": "idle" | "running" | "done" | "failed" | "unsure"}, with
    "progress" (0 to 1) while running and "matched" (the share of the
    lyrics heard), "lines_matched" and "lines" once there is a result; for
    lyrics the browser sent, "done" carries the timing itself, "aligned"."""
    job, job_dir = _lyrics_job(job_id)
    run = RETIME_RUNS.current(job_id)
    if run is not None and (
        run.state not in ("done", "idle")
        or (run.outcome is not None and run.outcome.aligned is not None)
    ):
        return run.view()
    entry = read_lyrics(job_dir) if lyrics_path(job_dir).is_file() else None
    saved = saved_retime_view(entry)
    if run is not None and run.state == "idle" and saved["state"] != "done":
        return run.view()
    return saved


class UserSyncedBody(BaseModel):
    """The user's own timing of the lyrics, from the sync editor: LRC whose
    lines are the lyrics' own, one to one."""

    synced: str = Field(min_length=1, max_length=LYRICS_TIMED_MAX_CHARS)


@router.put("/{job_id}/lyrics/user-synced")
async def put_user_synced(job_id: str, request: Request) -> dict:
    """Keep the user's own timing of the track's lyrics, shown before any
    other (see app/pipeline/lyrics_retime.py). 422 when it is not LRC, its
    stamps go back in time, or its lines are not exactly the lyrics' own:
    it can time them, never change them."""
    job, job_dir = _lyrics_job(job_id)
    body = await _lyrics_body(request, UserSyncedBody, max_bytes=_TIMED_BODY_MAX_BYTES)
    try:
        entry = await asyncio.to_thread(set_user_synced, job, job_dir, body.synced)
    except NotTheseLyrics as exc:
        raise HTTPException(status_code=422, detail="not a timing of these lyrics") from exc
    if entry is None:
        if not lyrics_path(job_dir).is_file():
            raise HTTPException(status_code=404, detail="no lyrics")
        raise HTTPException(status_code=500, detail=LYRICS_NOT_SAVED)
    return {"user_synced": entry["user_synced"]}


@router.delete("/{job_id}/lyrics/user-synced")
async def delete_user_synced(job_id: str) -> dict:
    """Drop the user's own timing of the track's lyrics. Idempotent."""
    job, job_dir = _lyrics_job(job_id)
    if not lyrics_path(job_dir).is_file():
        raise HTTPException(status_code=404, detail="no lyrics")
    entry = await asyncio.to_thread(set_user_synced, job, job_dir, None)
    if entry is None:
        raise HTTPException(status_code=500, detail=LYRICS_NOT_SAVED)
    return {"user_synced": None}


class UserLyricsBody(BaseModel):
    """The user's own words, pasted, loaded from a file or edited: plain text
    or LRC, told apart by whether any line starts with a timestamp."""

    text: str
    keep_timing: StrictBool = False


@router.put("/{job_id}/lyrics/user-text")
async def put_user_text(job_id: str, request: Request) -> Response:
    """Keep the user's own words as the track's lyrics, in place of what it
    has (set_user_lyrics). Answers as GET .../lyrics then would. 409 before the
    job is done, while its pipeline can still write lyrics; 413 when too long;
    422, with a message for the user, when they are not usable."""
    job, job_dir = _lyrics_job(job_id)
    body = await _lyrics_body(request, UserLyricsBody)
    if job.status != "done":
        raise HTTPException(status_code=409, detail="job not ready")
    try:
        entry = await asyncio.to_thread(set_user_lyrics, job, job_dir, body.text, body.keep_timing)
    except LyricsTooLong as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except UnusableLyrics as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if entry is None:
        raise HTTPException(status_code=500, detail=LYRICS_NOT_SAVED)
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return await asyncio.to_thread(get_lyrics, job_id)


@router.delete("/{job_id}/lyrics/user-text")
async def delete_user_text(job_id: str) -> Response:
    """Go back to the found or transcribed lyrics the user's own replaced.
    Idempotent. Answers as GET .../lyrics then would, so 404 when the user's
    were all the track had."""
    job, job_dir = _lyrics_job(job_id)
    if not await asyncio.to_thread(restore_lyrics, job, job_dir):
        raise HTTPException(status_code=500, detail="could not restore lyrics")
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return await asyncio.to_thread(get_lyrics, job_id)


class LyricsChoiceBody(BaseModel):
    """A version of the track's lyrics as GET .../lyrics answers one, checked
    whole by lyrics_choice.choose_lyrics."""

    model_config = ConfigDict(extra="allow")


@router.put("/{job_id}/lyrics")
async def put_lyrics(
    job_id: str,
    request: Request,
    picked: bool = True,
    carry_over: bool = False,
) -> Response:
    """Keep a version as the track's lyrics, on every device and in song
    bundles (app/pipeline/lyrics_choice.py): the user's pick, or with
    ?picked=false lyrics kept as found ones are, without ``chosen``. With
    ?picked=false or ?carry_over=true, a decision the server holds stays.
    Answers as GET .../lyrics then would. 409 until the job is done or for a
    live pick over the user's own words; 413 too long; 422 not a version."""
    job, job_dir = _lyrics_job(job_id)
    body = await _lyrics_body(request, LyricsChoiceBody, max_bytes=_CHOICE_BODY_MAX_BYTES)
    if job.status != STATUS_DONE:
        raise HTTPException(status_code=409, detail=JOB_NOT_READY)
    try:
        kept = await asyncio.to_thread(
            choose_lyrics,
            job,
            job_dir,
            body.model_dump(),
            picked=picked,
            carry_over=carry_over,
        )
    except NotAVersion as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except UsersOwnWords as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not kept:
        raise HTTPException(status_code=500, detail=LYRICS_NOT_SAVED)
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return await asyncio.to_thread(get_lyrics, job_id)


@router.delete("/{job_id}/lyrics")
async def delete_lyrics(job_id: str, carry_over: bool = False) -> Response:
    """Remove the track's lyrics on every device and from song bundles, and
    keep them away from later lookups until lyrics are kept again. Idempotent.
    With ?carry_over=true, a removal a browser kept for the track, which
    leaves any decision the server already holds as it is. Answers as GET
    .../lyrics then would. 409 until the job is done."""
    job, job_dir = _lyrics_job(job_id)
    if job.status != STATUS_DONE:
        raise HTTPException(status_code=409, detail=JOB_NOT_READY)
    if not await asyncio.to_thread(remove_lyrics, job, job_dir, carry_over=carry_over):
        raise HTTPException(status_code=500, detail=LYRICS_NOT_REMOVED)
    await asyncio.to_thread(registry_persist, JOBS_DIR)
    return await asyncio.to_thread(get_lyrics, job_id)


# Upper bound on an edited grid. A 20-minute track at 300 BPM is ~6000 beats;
# 20000 leaves generous headroom while refusing a payload crafted to exhaust
# memory or disk.
_MAX_EDITED_BEATS = 20000
_MAX_BARS = 2000


class BarMark(BaseModel):
    """A downbeat and the bar length that runs from it until the next mark."""

    beat: int = Field(ge=0, lt=_MAX_EDITED_BEATS)
    beats_per_bar: int = Field(ge=1, le=TEMPO_MAX_BEATS_PER_BAR)


class TempoBody(BaseModel):
    """The user's tempo settings. Partial: an omitted field is left as it was,
    and a field sent as null goes back to the detected value."""

    mode: Literal[MODE_CONSTANT, MODE_FOLLOW] | None = None
    bpm: float | None = Field(default=None, ge=TEMPO_MIN_BPM, le=TEMPO_MAX_BPM)
    anchor: float | None = Field(default=None, ge=0)
    beats_per_bar: int | None = Field(default=None, ge=1, le=TEMPO_MAX_BEATS_PER_BAR)

    @field_validator("bpm")
    @classmethod
    def _round_bpm(cls, v: float | None) -> float | None:
        return None if v is None else round(v, TEMPO_BPM_DECIMALS)

    @field_validator("anchor")
    @classmethod
    def _round_anchor(cls, v: float | None) -> float | None:
        return None if v is None else round(v, BEAT_TIME_DECIMALS)


class BeatsBody(BaseModel):
    beats: list[float] | None = Field(default=None, max_length=_MAX_EDITED_BEATS)
    bars: list[BarMark] = Field(default_factory=list, max_length=_MAX_BARS)
    tempo: TempoBody | None = None

    @model_validator(mode="after")
    def _has_an_edit(self) -> BeatsBody:
        if self.beats is None and self.tempo is None:
            raise ValueError("nothing to save")
        return self

    @field_validator("beats")
    @classmethod
    def _check_beats(cls, v: list[float] | None) -> list[float] | None:
        if v is None:
            return v
        # The client scheduler binary-searches this array and assumes it is
        # sorted and strictly increasing; enforce that at the boundary rather
        # than trusting the editor to have maintained it.
        out: list[float] = []
        for t in v:
            if not math.isfinite(t) or not (0 <= t < 86400):
                raise ValueError("beat time out of range")
            r = round(float(t), 6)
            if out and r <= out[-1]:
                raise ValueError("beat times must be strictly increasing")
            out.append(r)
        return out


def _beats_paths(job_id: str) -> tuple[Path, Path]:
    """(computed, user-edited) grid paths, both verified inside JOBS_DIR."""
    stems = (JOBS_DIR / job_id / "stems").resolve()
    if not stems.is_relative_to(JOBS_DIR.resolve()):
        raise HTTPException(status_code=404, detail="job not found")
    return stems / "beats.json", stems / "beats.user.json"


# Keys of error.txt that may be handed to the client. `title` and `source` are
# deliberately absent: this feeds a "report it on GitHub" flow whose issues are
# public, and the user adds what they were working on if they want to. The
# server is the right place to enforce that -- not the client that builds the
# report body.
_FAILURE_PUBLIC_KEYS = frozenset(
    ("time", "stage", "device", "model", "cause", "timings", "exception")
)


@router.get("/{job_id}/failure")
def get_failure(job_id: str) -> dict:
    """Return the quarantined failure evidence for a job that errored.

    _quarantine_failed_job writes jobs/failed/<id>/error.txt on every pipeline
    failure (#277) and until now nothing ever read it back: the UI had only the
    one-line `error_detail`, so a bug report could not carry the stderr tail or
    the full traceback that say *why* demucs died. Read-only, and never serves
    the whole file -- only the technical keys above, plus the tail and
    traceback (both already home-directory-redacted by the writer).
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")

    # JOB_ID_RE rejects "failed", so the quarantine dir can never be addressed
    # as a job id; join it explicitly and re-verify the result stays inside.
    failed_dir = _failure_dir(job_id).resolve()
    if not failed_dir.is_relative_to((JOBS_DIR / FAILED_DIR_NAME).resolve()):
        raise HTTPException(status_code=404, detail="job not found")
    path = failed_dir / "error.txt"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="no failure evidence for this job")

    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.exception("unreadable failure evidence for %s", job_id)
        raise HTTPException(status_code=404, detail="no failure evidence for this job") from exc

    fields: dict[str, str] = {}
    tail: list[str] = []
    tb: list[str] = []
    section = "fields"
    for line in text.splitlines():
        stripped = line.strip()
        if stripped == "--- stderr tail ---":
            section = "tail"
            continue
        if stripped == "--- traceback ---":
            # The writer separates sections with a blank line for readability
            # in the raw file; drop it here rather than let it show up as a
            # trailing empty entry in `tail`.
            if tail and tail[-1] == "":
                tail.pop()
            section = "traceback"
            continue
        if section == "tail":
            tail.append(line)
            continue
        if section == "traceback":
            tb.append(line)
            continue
        key, sep, value = line.partition(":")
        if sep and key in _FAILURE_PUBLIC_KEYS:
            fields[key] = value.strip()

    return {"job_id": job_id, **fields, "tail": tail, "traceback": tb}


@router.get("/{job_id}/beats")
def get_beats(job_id: str) -> Response:
    """Return the beat grid, preferring the user's edits over the detected one.

    Deliberately separate from the immutable `stems/beats.json`: that file is
    a computed artifact and is cached forever, while this response changes
    whenever the user edits and must never be cached.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(status_code=404, detail="job not ready")

    computed_path, user_path = _beats_paths(job_id)
    grid = read_detected_grid(computed_path)
    if grid is None:
        raise HTTPException(status_code=404, detail="beat grid not found")
    return JSONResponse(
        effective_grid(grid, read_beat_edits(user_path)),
        headers={"Cache-Control": "no-store"},
    )


def _reject_non_finite(_token: str) -> float:
    """`json.loads` parse_constant hook.

    Python's JSON parser accepts the non-standard `NaN`, `Infinity` and
    `-Infinity` literals. Letting them reach Pydantic produces a validation
    error whose `input` field holds the non-finite float, and FastAPI then
    cannot serialise its own 422 -- the request fails with a 500 and a
    traceback instead of a clean rejection. Refusing them at parse time keeps
    the error a plain string.
    """
    raise ValueError("non-finite numbers are not accepted")


async def _parse_beats_body(request: Request) -> BeatsBody:
    """Parse and validate a beats payload, rejecting non-finite floats first."""
    try:
        raw = await request.body()
        data = json.loads(raw, parse_constant=_reject_non_finite)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail="invalid JSON body") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="expected a JSON object")
    try:
        return BeatsBody(**data)
    except Exception as exc:
        # Message only -- never echo the submitted values back.
        raise HTTPException(status_code=422, detail="invalid beat grid") from exc


@router.patch("/{job_id}/beats")
async def update_beats(job_id: str, request: Request) -> dict:
    """Persist an edited beat grid and/or the user's tempo settings.

    Written to a separate file from the detected grid so re-running analysis
    can never silently discard a user's corrections. `beats` replaces the
    edited beats and bars and, unless the body also sets `tempo.mode`, switches
    the song to follow mode -- edited beats are only heard when followed.
    `tempo` is merged field by field into what was saved before.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    body = await _parse_beats_body(request)
    job = registry_get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(status_code=404, detail="job not ready")

    computed_path, user_path = _beats_paths(job_id)
    grid = read_detected_grid(computed_path)
    if grid is None:
        raise HTTPException(status_code=404, detail="beat grid not found")

    saved = read_beat_edits(user_path)
    payload = {
        "version": 1,
        "beats": saved.get("beats") or [],
        "bars": saved.get("bars") or [],
    }
    tempo = dict(saved["tempo"]) if isinstance(saved.get("tempo"), dict) else {}
    if body.beats is not None:
        payload["beats"] = body.beats
        payload["bars"] = [b.model_dump() for b in body.bars]
        tempo.pop("mode", None)
    if body.tempo is not None:
        for key, value in body.tempo.model_dump(exclude_unset=True).items():
            if value is None:
                tempo.pop(key, None)
            else:
                tempo[key] = value
    if tempo.get("anchor", 0.0) > float(grid.get("duration") or 0.0):
        raise HTTPException(status_code=422, detail="anchor is beyond the end of the track")
    if tempo:
        payload["tempo"] = tempo
    try:
        write_json_atomic(user_path, payload)
    except OSError as exc:
        logger.exception("failed to write beat edits for %s", job_id)
        raise HTTPException(status_code=500, detail="failed to save beat grid") from exc

    effective = effective_grid(grid, payload)
    return {
        "job_id": job_id,
        "beats": len(effective["beats"]),
        "edited": True,
        "tempo": effective["tempo"],
    }


@router.delete("/{job_id}/beats")
def reset_beats(job_id: str) -> dict:
    """Discard the user's beat and bar edits and fall back to the detected beats.

    Tempo settings are kept; the user clears those field by field with PATCH.
    """
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(status_code=404, detail="job not ready")

    _, user_path = _beats_paths(job_id)
    tempo = read_beat_edits(user_path).get("tempo")
    keep = tempo if isinstance(tempo, dict) and tempo else None
    try:
        if keep:
            write_json_atomic(user_path, {"version": 1, "beats": [], "bars": [], "tempo": keep})
        else:
            user_path.unlink(missing_ok=True)
    except OSError as exc:
        logger.exception("failed to reset beat edits for %s", job_id)
        raise HTTPException(status_code=500, detail="failed to reset beat grid") from exc
    return {"job_id": job_id, "edited": keep is not None}


def _seconds_left(deadline: float) -> float:
    return max(0.0, deadline - time.monotonic())


def _wait_vocal_split_ended(job_id: str, deadline: float) -> None:
    """Wait until ``deadline`` for a stopped split to let go of the vocals."""
    if not VOCAL_SPLIT_RUNS.wait_ended(job_id, _seconds_left(deadline)):
        logger.warning("[%s] vocal split still stopping; carrying on", job_id)


def _wait_lyrics_runs_ended(job_id: str, deadline: float) -> None:
    """Wait until ``deadline`` for stopped lyrics runs to let go of the vocals."""
    if not RETIME_RUNS.wait_ended(job_id, _seconds_left(deadline)):
        logger.warning("[%s] lyrics timing still stopping; removing files anyway", job_id)
    if not TRANSCRIBE_RUNS.wait_ended(job_id, _seconds_left(deadline)):
        logger.warning("[%s] lyrics transcription still stopping; removing files anyway", job_id)


@router.delete("/{job_id}")
def delete_job(job_id: str) -> dict[str, str]:
    """Delete a completed or failed job and remove its stem files from disk."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    with _RETRY_LOCK:
        job = _known_job(job_id)
        if job is None:
            return _retry_deleted_job_files(job_id)
        if job.status not in FINISHED_STATUSES:
            raise HTTPException(status_code=409, detail="job is still running")
        if not _remove_job(job):
            raise HTTPException(status_code=500, detail=_FILES_NOT_DELETED_DETAIL)
    return {"job_id": job_id, "status": "deleted"}


def _remove_job(job: Job) -> bool:
    """Take a finished job out of the library and off the disk. False means
    its record is gone but some of its files are still there."""
    job_id = job.id
    # A lyrics run or a split in flight stops rather than write into a
    # directory being removed (each also checks the job is still registered).
    _stop_runs(job, with_lyrics=True)
    # A fingerprint of its audio may still have a file open (Windows).
    release_source(job_id)
    removed = _rmtree_job(job_id)
    # A failed job's kept upload and record go with it, or a restart reads it back.
    removed = remove_job_dir(_failure_dir(job_id)) and removed
    # Recorded whether or not the files went away. The user asked for this job
    # to be gone; without the record, a directory that outlived the delete is
    # re-adopted by restore() on the next start and the track reappears.
    registry_mark_deleted(job_id)
    registry_remove(job_id)
    registry_persist(JOBS_DIR)
    setlists_remove_songs(JOBS_DIR, [job_id])
    return removed


def _stop_runs(job: Job, *, with_lyrics: bool) -> None:
    """Stop a finished job's vocal split, and its lyrics runs too when
    ``with_lyrics``, wait on one deadline for them to end, then forget them."""
    job_id = job.id
    lyrics_run = with_lyrics and _cancel_lyrics_runs(job_id)
    splitting = cancel_split(job)
    if lyrics_run or splitting:
        _terminate_worker(job_id)
        deadline = time.monotonic() + RETIME_DELETE_WAIT_SEC
        if with_lyrics:
            _wait_lyrics_runs_ended(job_id, deadline)
        _wait_vocal_split_ended(job_id, deadline)
    if with_lyrics:
        RETIME_RUNS.forget(job_id)
        TRANSCRIBE_RUNS.forget(job_id)
    VOCAL_SPLIT_RUNS.forget(job_id)


def _retry_deleted_job_files(job_id: str) -> dict[str, str]:
    """Remove the files a deleted job left behind. Only a job the user deleted
    qualifies, so an orphan directory awaiting adoption is never removed."""
    if not registry_is_deleted(job_id) or not (JOBS_DIR / job_id).is_dir():
        raise HTTPException(status_code=404, detail="job not found")
    release_source(job_id)
    if not _rmtree_job(job_id):
        raise HTTPException(status_code=500, detail=_FILES_NOT_DELETED_DETAIL)
    return {"job_id": job_id, "status": "deleted"}


def _apply_replacement(job: Job) -> None:
    """Settle the old copy a job re-imported, now that the job is done.

    An old copy whose files are gone ("Sync again" on an unavailable song) is
    deleted outright. One that still plays goes to the Trash instead: it may
    carry the user's sections, lyrics and tempo edits. Either way the new copy
    takes the old one's place in every setlist. An old copy the user trashed or
    deleted meanwhile is left as it is, and so is everything when the new job
    itself was trashed as it finished.

    Settled, whatever the outcome, the job forgets ``replaces``, so an old copy
    the user later restores from the Trash is never trashed again. A failure
    leaves it set for settle_pending_replacements() on the next start.
    """
    if job.replaces is None:
        return
    if job.trashed_at is None:
        _settle_old_copy(job)
    job.replaces = None
    registry_persist(JOBS_DIR)


def _settle_old_copy(job: Job) -> None:
    old = _known_job(job.replaces)
    if old is None or old.trashed_at is not None or old.status not in FINISHED_STATUSES:
        return
    # Before the delete below, which would take the old copy out of its setlists.
    setlists_replace_song(JOBS_DIR, old.id, job.id)
    if _job_files_missing(old):
        logger.info("[%s] replaces %s, whose files are gone: deleting it", job.id, old.id)
        if not _remove_job(old):
            logger.warning("[%s] replaced job %s left files behind", job.id, old.id)
        return
    logger.info("[%s] replaces %s: moving it to the Trash", job.id, old.id)
    registry_set_trashed(old.id, True)
    _stop_runs(old, with_lyrics=False)


def settle_pending_replacements() -> None:
    """Settle every replacement a done job still holds from the last run: the
    process died, or the done hook failed, before the old copy was settled."""
    pending = [
        job
        for job in registry_all_jobs().values()
        if job.status == STATUS_DONE and job.replaces is not None
    ]
    for job in pending:
        try:
            _apply_replacement(job)
        except Exception:
            logger.exception("[%s] could not settle the copy it replaces", job.id)


set_on_done(_apply_replacement)
