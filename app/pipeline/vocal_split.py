"""On-demand lead/backing vocal split (#275).

A post-hoc action on an already-"done" job (POST /api/jobs/{id}/vocal-split
in app/api/jobs.py), not part of the main separate/collect pipeline. Runs
UVR-MDX-NET Karaoke 2 (or STEMDECK_KARAOKE_MODEL's override) on the job's
existing stems/vocals.wav via a fresh subprocess per invocation --
deliberately not a persistent worker like demucs_worker.py, since this is an
occasional user-triggered action, not the hot path every job takes (the
persistent-worker pattern in ml-pipeline.md exists specifically to amortize a
cost every job pays; that reasoning doesn't apply here, #309).

A split runs in the background as a run of its own kind (runs.RunBoard,
VOCAL_SPLIT_RUNS): behind the pipeline lock, followed by GET .../vocal-split
for its phase and progress (the worker's tqdm percentages), and stopped by
the job's cancel or deletion. How it ended is kept on the job, which is
persisted with the registry: job.vocal_split (the VOCAL_SPLIT_* states in
app.core.models), and for a failure job.vocal_split_error, a
VOCAL_SPLIT_FAILED_* code. The worker's own words go only to the log and to
stems/vocal_split_error.txt, with the code, which is what a job rebuilt from
disk reads it back from. A failed or cancelled split leaves nothing of itself
behind, and never touches vocals.wav or the job's status.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, cast, get_args

from app.core.config import (
    EXTRA_STEM_NAMES,
    JOBS_DIR,
    TIMEOUT_VOCAL_SPLIT,
    VOCAL_SPLIT_CANCEL_POLL_SEC,
)
from app.core.models import (
    VOCAL_SPLIT_CANCELLED,
    VOCAL_SPLIT_CHOICE_SPLIT,
    VOCAL_SPLIT_DONE,
    VOCAL_SPLIT_ERROR,
    VOCAL_SPLIT_FAILED_DISK_FULL,
    VOCAL_SPLIT_FAILED_NO_OUTPUT,
    VOCAL_SPLIT_FAILED_NO_VOCALS,
    VOCAL_SPLIT_FAILED_OUT_OF_MEMORY,
    VOCAL_SPLIT_FAILED_STALLED,
    VOCAL_SPLIT_FAILED_UNSUPPORTED_DEVICE,
    VOCAL_SPLIT_FAILED_WORKER,
    VOCAL_SPLIT_RUNNING,
    Job,
    JobCancelled,
    VocalSplitFailure,
    _set,
)
from app.core.registry import persist as registry_persist
from app.core.registry import set_proc
from app.core.settings import get_demucs_device
from app.core.stem_files import StemDecodeError, decoded_wav, stem_path, stem_url
from app.pipeline.collect import merge_stem_peaks, presence_for_split
from app.pipeline.errors import (
    CAUSE_DISK_FULL,
    CAUSE_OUT_OF_MEMORY,
    CAUSE_UNSUPPORTED_DEVICE,
    SeparationError,
    classify_failure,
)
from app.pipeline.runs import Run, RunBoard, run_behind_lock
from app.pipeline.stem_storage import store_split_stems

logger = logging.getLogger("stemdeck.pipeline")

VOCAL_SPLIT_ERROR_FILE = "vocal_split_error.txt"

# The phase of a running split: waiting for the pipeline lock, then the worker.
PHASE_QUEUED = "queued"
PHASE_SPLITTING = "splitting"

_DONE_MARKER = "@@DONE@@"
_ERROR_MARKER = "@@ERROR@@"
# A tqdm bar line from audio-separator, "45%|####  | 9/20".
_PROGRESS_RE = re.compile(r"^(\d{1,3})%\|")
_PERCENT = 100
_PROGRESS_DIGITS = 3
_TAIL_LINES = 40
_LOGGED_TAIL_LINES = 15
_WATCHDOG_JOIN_SEC = 2
_STOP_WAIT_SEC = 5

_CAUSE_KEY = "cause: "
_CODE_KEY = "code: "
_FAILURE_CODES: frozenset[str] = frozenset(get_args(VocalSplitFailure))
# classify_failure's causes that name a failure of their own; any other is the
# worker's code, or VOCAL_SPLIT_FAILED_WORKER.
_CAUSE_CODES: dict[str, VocalSplitFailure] = {
    CAUSE_OUT_OF_MEMORY: VOCAL_SPLIT_FAILED_OUT_OF_MEMORY,
    CAUSE_UNSUPPORTED_DEVICE: VOCAL_SPLIT_FAILED_UNSUPPORTED_DEVICE,
    CAUSE_DISK_FULL: VOCAL_SPLIT_FAILED_DISK_FULL,
}
_STAGE_SPLITTING = "Splitting lead/backing vocals..."
_STAGE_DONE = "Done"


class VocalSplitFailed(SeparationError):
    """A split that failed, with the VOCAL_SPLIT_FAILED_* code saying why."""

    def __init__(
        self,
        message: str,
        *,
        code: VocalSplitFailure,
        tail: list[str] | None = None,
        device: str | None = None,
    ) -> None:
        super().__init__(message, tail=tail, device=device)
        self.code = code


@dataclass
class VocalSplitRun(Run):
    """One on-demand split, RUNNING until it ends in a VOCAL_SPLIT_* state."""

    cancelled_state: ClassVar[str] = VOCAL_SPLIT_CANCELLED

    phase: str = PHASE_QUEUED

    def report(self, pct: int) -> None:
        self.phase = PHASE_SPLITTING
        self.progress = pct / _PERCENT


VOCAL_SPLIT_RUNS: RunBoard[VocalSplitRun] = RunBoard(VocalSplitRun)


def _spawn_cmd(device: str, vocals_path: Path, out_dir: Path) -> list[str]:
    return [
        sys.executable,
        "-m",
        "app.pipeline.vocal_split_worker",
        device,
        str(vocals_path),
        str(out_dir),
    ]


def _spawn(device: str, vocals_path: Path, out_dir: Path) -> subprocess.Popen:
    env = os.environ.copy()
    # Pin the child's stdio encoding to match what the parent now decodes with.
    # Without it a Windows child writes cp1252 while the parent reads utf-8, so
    # the mismatch simply moves rather than being fixed. Demucs and audio-
    # separator both emit progress bars and can echo track metadata, neither of
    # which is guaranteed to be cp1252-safe.
    # The worker arms a watchdog on this and hard-exits when we disappear, so a
    # kill that runs no cleanup (SIGKILL, Force Quit, Task Manager, a crash)
    # cannot leave it running with nobody to collect the result (#519).
    env["STEMDECK_PARENT_PID"] = str(os.getpid())
    env["PYTHONIOENCODING"] = "utf-8:replace"
    try:
        import certifi

        env.setdefault("SSL_CERT_FILE", certifi.where())
        env.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
    except ModuleNotFoundError:
        pass

    return subprocess.Popen(
        _spawn_cmd(device, vocals_path, out_dir),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        # utf-8/replace explicitly. text=True alone decodes with the locale
        # encoding, which on Windows is cp1252, and a single byte outside it
        # in a child's output kills the whole job with a UnicodeDecodeError
        # ("'charmap' codec can't decode byte 0x8f"). This is diagnostic text:
        # a byte we cannot read is never a reason to fail a separation.
        # Text mode also splits tqdm's carriage-return frames into lines.
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=env,
    )


def _watch(
    job: Job,
    proc: subprocess.Popen,
    cancelled: Callable[[], bool],
    last_output: list[float],
    done_evt: threading.Event,
    stalled: threading.Event,
) -> None:
    """Stop the worker on a cancel, or when it has said nothing for
    TIMEOUT_VOCAL_SPLIT seconds (setting ``stalled``)."""
    while not done_evt.wait(timeout=VOCAL_SPLIT_CANCEL_POLL_SEC):
        if proc.poll() is not None:
            return
        if cancelled():
            logger.info("[%s] vocal split cancelled, stopping the worker", job.id)
            proc.terminate()
            return
        if time.monotonic() - last_output[0] > TIMEOUT_VOCAL_SPLIT:
            logger.warning(
                "vocal split stalled for %ss with no output, terminating job %s",
                TIMEOUT_VOCAL_SPLIT,
                job.id,
            )
            stalled.set()
            proc.terminate()
            return


def _error_message(line: str) -> tuple[str, VocalSplitFailure | None]:
    """The worker's error line as its message, and its code if it gave one."""
    msg = line[len(_ERROR_MARKER) :]
    try:
        parsed = json.loads(msg)
    except json.JSONDecodeError:
        return msg, None
    if isinstance(parsed, dict):
        code = parsed.get("code")
        known = cast(VocalSplitFailure, code) if code in _FAILURE_CODES else None
        return str(parsed.get("message", "")), known
    return str(parsed), None


def _read_outcome(
    proc: subprocess.Popen,
    last_output: list[float],
    report: Callable[[int], None],
) -> tuple[bool, list[str], VocalSplitFailure | None]:
    """Follow the worker's stderr to its end: whether it said it succeeded,
    the last lines it wrote that were not progress, and its failure code."""
    tail: list[str] = []
    assert proc.stderr is not None
    for raw_line in proc.stderr:
        last_output[0] = time.monotonic()
        line = raw_line.strip()
        if not line:
            continue
        if line == _DONE_MARKER:
            return True, tail, None
        if line.startswith(_ERROR_MARKER):
            message, code = _error_message(line)
            tail.append(message)
            return False, tail, code
        progress = _PROGRESS_RE.match(line)
        if progress is not None:
            report(int(progress.group(1)))
            continue
        tail.append(line)
        if len(tail) > _TAIL_LINES:
            tail.pop(0)
    return False, tail, None


def _worker_code(tail: list[str], code: VocalSplitFailure | None) -> VocalSplitFailure:
    """What the worker's failure was: stalled, what its output names (out of
    memory, an unsupported device, a full disk), else the code it gave, else
    a failure of the worker."""
    if code == VOCAL_SPLIT_FAILED_STALLED:
        return code
    cause = classify_failure("\n".join(tail))
    return _CAUSE_CODES.get(cause) or code or VOCAL_SPLIT_FAILED_WORKER


def _stop(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=_STOP_WAIT_SEC)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.communicate()


def _run_worker(
    job: Job,
    device: str,
    vocals_path: Path,
    out_dir: Path,
    cancelled: Callable[[], bool],
    report: Callable[[int], None],
) -> tuple[bool, list[str], VocalSplitFailure | None]:
    """Run the worker to its end under the watchdog, writing into `out_dir`:
    whether it succeeded, its last lines, and its failure code
    (VOCAL_SPLIT_FAILED_STALLED when the watchdog stopped it for silence)."""
    proc = _spawn(device, vocals_path, out_dir)
    set_proc(job.id, proc)
    last_output = [time.monotonic()]
    done_evt = threading.Event()
    stalled = threading.Event()
    watchdog = threading.Thread(
        target=_watch,
        args=(job, proc, cancelled, last_output, done_evt, stalled),
        daemon=True,
    )
    watchdog.start()
    try:
        job_ok, tail, code = _read_outcome(proc, last_output, report)
    finally:
        done_evt.set()
        set_proc(job.id, None)
        watchdog.join(timeout=_WATCHDOG_JOIN_SEC)
        _stop(proc)
    return job_ok, tail, VOCAL_SPLIT_FAILED_STALLED if stalled.is_set() else code


def _worker_failed(
    job: Job,
    tail: list[str],
    code: VocalSplitFailure | None,
    device: str,
) -> VocalSplitFailed:
    detail = "\n".join(tail[-_LOGGED_TAIL_LINES:]) if tail else "(no stderr captured)"
    logger.warning("[%s] vocal split failed: %s", job.id, detail)
    last = tail[-1] if tail else "vocal split failed"
    return VocalSplitFailed(
        f"vocal split failed: {last}",
        code=_worker_code(tail, code),
        tail=tail[-_TAIL_LINES:],
        device=device,
    )


def split_vocals(
    job: Job,
    stems_dir: Path,
    *,
    cancelled: Callable[[], bool],
    report: Callable[[int], None],
) -> list[str]:
    """Run the karaoke model on stems/vocals.wav, producing lead_vocals.wav +
    backing_vocals.wav in stems_dir. Returns the two new stem names on
    success. Raises VocalSplitFailed (carrying its code and the stderr tail)
    on failure, and JobCancelled once ``cancelled()`` turned true. ``report``
    hears the worker's percentages. Never touches vocals.wav itself."""
    vocals_path = stem_path(stems_dir, "vocals")
    if not vocals_path.is_file():
        raise VocalSplitFailed(
            "vocals.wav not found -- job has no vocals stem to split",
            code=VOCAL_SPLIT_FAILED_NO_VOCALS,
        )
    # The worker writes into the dot temp folder `.vocal_split.<hex>.tmp`, and
    # the pair moves in only once both are whole: a kill never leaves a
    # half-written lead_vocals.wav that reads as a stem (upstream PR 898).
    work = stems_dir / f".vocal_split.{uuid.uuid4().hex}.tmp"
    try:
        work.mkdir()
        # audio-separator gets a WAV whatever the song keeps.
        with decoded_wav(vocals_path, work) as wav_in:
            _split_into(job, wav_in, work, cancelled=cancelled, report=report)
        return _move_in(work, stems_dir)
    except StemDecodeError as exc:
        raise VocalSplitFailed(
            "could not read the vocals stem", code=VOCAL_SPLIT_FAILED_WORKER
        ) from exc
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _split_into(
    job: Job,
    vocals_path: Path,
    work: Path,
    *,
    cancelled: Callable[[], bool],
    report: Callable[[int], None],
) -> None:
    """Run the worker into `work` and check it made the pair."""
    device = get_demucs_device()
    job_ok, tail, code = _run_worker(job, device, vocals_path, work, cancelled, report)
    if cancelled():
        raise JobCancelled()
    if not job_ok:
        raise _worker_failed(job, tail, code, device)
    for name in EXTRA_STEM_NAMES:
        if not (work / f"{name}.wav").is_file():
            raise VocalSplitFailed(
                f"vocal split did not produce {name}.wav",
                code=VOCAL_SPLIT_FAILED_NO_OUTPUT,
                device=device,
            )


def _move_in(work: Path, stems_dir: Path) -> list[str]:
    """Move the pair from `work` into the stems. A move that fails takes back
    the one already made; a kill between the two renames leaves a lead alone,
    which a song rebuilt from its folder does not count as split."""
    placed: list[Path] = []
    try:
        for name in EXTRA_STEM_NAMES:
            final = stems_dir / f"{name}.wav"
            os.replace(work / f"{name}.wav", final)
            placed.append(final)
    except OSError as exc:
        for final in placed:
            final.unlink(missing_ok=True)
        raise VocalSplitFailed(
            "could not move the split stems in", code=VOCAL_SPLIT_FAILED_WORKER
        ) from exc
    return list(EXTRA_STEM_NAMES)


def _discard_partial(stems_dir: Path) -> None:
    for name in EXTRA_STEM_NAMES:
        (stems_dir / f"{name}.wav").unlink(missing_ok=True)


def _write_error(stems_dir: Path, cause: str, code: str, tail: list[str]) -> None:
    lines = [f"{_CAUSE_KEY}{cause}", f"{_CODE_KEY}{code}", "", "--- stderr tail ---", *tail]
    try:
        (stems_dir / VOCAL_SPLIT_ERROR_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        logger.warning("could not write %s in %s", VOCAL_SPLIT_ERROR_FILE, stems_dir, exc_info=True)


def read_error_code(stems_dir: Path) -> VocalSplitFailure | None:
    """Why the split in ``stems_dir`` failed, from its error file: its
    VOCAL_SPLIT_FAILED_* code, VOCAL_SPLIT_FAILED_WORKER for a file without
    a known one. None when there is no such file."""
    try:
        lines = (stems_dir / VOCAL_SPLIT_ERROR_FILE).read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        code = line.removeprefix(_CODE_KEY)
        if line.startswith(_CODE_KEY) and code in _FAILURE_CODES:
            return cast(VocalSplitFailure, code)
    return VOCAL_SPLIT_FAILED_WORKER


def _record_failure(job: Job, stems_dir: Path, exc: Exception) -> None:
    """Mark the split failed, with its code on the job and in the error file."""
    tail = getattr(exc, "tail", None) or [str(exc)]
    code = exc.code if isinstance(exc, VocalSplitFailed) else VOCAL_SPLIT_FAILED_WORKER
    logger.warning("[%s] vocal split failed (%s): %s", job.id, code, exc, exc_info=exc)
    _write_error(stems_dir, classify_failure("\n".join([*tail, str(exc)])), code, tail)
    _set(job, vocal_split=VOCAL_SPLIT_ERROR, vocal_split_error=code, stage=_STAGE_DONE)


def _keep(job: Job, stems_dir: Path, new_names: list[str]) -> None:
    # "vocals" rides along so presence_for_split can recover the scale the base
    # stems were normalised against; without it the two new cards would have no
    # percentage to show. Read before the pair is stored like the song.
    rms_values = merge_stem_peaks(stems_dir, ["vocals", *new_names])
    store_split_stems(job, stems_dir, new_names)
    existing = {s["name"] for s in job.stems}
    for name in new_names:
        if name not in existing:
            job.stems.append({"name": name, "url": stem_url(job.id, stems_dir, name)})
    extra_presence = presence_for_split(rms_values, job.stem_presence)
    if extra_presence:
        job.stem_presence = {**(job.stem_presence or {}), **extra_presence}
    (stems_dir / VOCAL_SPLIT_ERROR_FILE).unlink(missing_ok=True)
    _set(job, vocal_split=VOCAL_SPLIT_DONE, vocal_split_error=None, stage=_STAGE_DONE)


def _mark_cancelled(job: Job) -> None:
    _set(job, vocal_split=VOCAL_SPLIT_CANCELLED, stage=_STAGE_DONE)


def split_now(
    job: Job,
    stems_dir: Path,
    *,
    cancelled: Callable[[], bool],
    report: Callable[[int], None],
) -> None:
    """Split the job's vocals and record how it ended on the job: DONE with
    the two stems added, or ERROR with its reason. Blocking. Raises
    JobCancelled, the job marked CANCELLED, once ``cancelled()`` turned true."""
    try:
        new_names = split_vocals(job, stems_dir, cancelled=cancelled, report=report)
    except JobCancelled:
        _discard_partial(stems_dir)
        _mark_cancelled(job)
        raise
    except Exception as exc:
        _discard_partial(stems_dir)
        _record_failure(job, stems_dir, exc)
        return
    _keep(job, stems_dir, new_names)


def begin_split(job: Job) -> None:
    """Mark a split started: the user asked for lead and backing vocals."""
    _set(
        job,
        vocal_split=VOCAL_SPLIT_RUNNING,
        vocal_split_choice=VOCAL_SPLIT_CHOICE_SPLIT,
        vocal_split_error=None,
        stage=_STAGE_SPLITTING,
    )


async def run_split(job: Job, stems_dir: Path, run: VocalSplitRun) -> None:
    """The split of a job begun with begin_split, as a background run behind
    the pipeline lock; the registry is persisted once it has ended."""

    def work(cancelled: Callable[[], bool]) -> None:
        run.phase = PHASE_SPLITTING
        split_now(job, stems_dir, cancelled=cancelled, report=run.report)
        run.state = job.vocal_split

    await run_behind_lock(job, run, work, "vocal split")
    if job.vocal_split == VOCAL_SPLIT_RUNNING:
        if run.state == VOCAL_SPLIT_CANCELLED:
            _mark_cancelled(job)
        else:
            _record_failure(job, stems_dir, RuntimeError("vocal split failed"))
    await asyncio.to_thread(registry_persist, JOBS_DIR)


def cancel_split(job: Job) -> bool:
    """Ask a running split of ``job`` to stop. True when one was running; one
    still waiting for the pipeline lock is cancelled at once."""
    if not VOCAL_SPLIT_RUNS.cancel(job.id):
        return False
    run = VOCAL_SPLIT_RUNS.current(job.id)
    if run is not None and run.state == VOCAL_SPLIT_CANCELLED:
        _mark_cancelled(job)
    return True


def split_view(job: Job) -> dict[str, Any]:
    """Where the job's split stands, for GET .../vocal-split: its state,
    choice and failure code, with phase and progress (0 to 1) while it runs."""
    out: dict[str, Any] = {
        "state": job.vocal_split,
        "choice": job.vocal_split_choice,
        "error": job.vocal_split_error,
    }
    run = VOCAL_SPLIT_RUNS.current(job.id)
    if job.vocal_split == VOCAL_SPLIT_RUNNING and run is not None:
        out["phase"] = run.phase
        out["progress"] = round(run.progress, _PROGRESS_DIGITS)
    return out
