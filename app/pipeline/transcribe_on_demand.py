"""Lyrics transcribed from the vocals when the user asks, for a track that has none.

transcribe.py transcribes at the end of an import, and only under the
transcribe_lyrics setting's terms ("auto": a CUDA job only). A track imported
while it was off, on a CPU under "auto", or before transcription existed, has
no lyrics and never gets any. POST .../lyrics/transcribe (app/api/transcribe.py)
asks for them here, from the Lyrics tab: on a GPU or the CPU alike, under
any setting but "off", in the background and behind the pipeline lock, like
the line-by-line timing of lyrics_retime.py, whose run machinery
(runs.RunBoard) it shares.

The result is the one an import makes: the worker always runs, and its
answer becomes lyrics.json with source "whisper" through build_lyrics. Like
an import, it keeps no transcript beside the lyrics.

The user's own lyrics always win: none is started while the track has lyrics
of any kind, and a result that finds lyrics there when it is done (the user
pasted theirs, or a lookup found some) is dropped.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar

from app.core.models import STATUS_DONE, Job, JobCancelled
from app.core.settings import TRANSCRIBE_LYRICS_OFF, get_demucs_device, get_transcribe_lyrics
from app.pipeline import transcribe
from app.pipeline.lyrics_lookup import (
    _OFFSET_LOCK,
    USER_SOURCE,
    lyrics_path,
    read_lyrics,
    write_lyrics,
)
from app.pipeline.runs import CANCELLED, DONE, FAILED, RUNNING, Run, RunBoard
from app.pipeline.transcribe import _run_worker, _vocals_reason, build_lyrics, whisper_device

logger = logging.getLogger("stemdeck.transcribe")

NO_SINGING = "no_singing"
HAS_LYRICS = "has_lyrics"

# The phase of a run still waiting for the pipeline lock.
QUEUED = "queued"
_PERCENT = 100

# Why a track gets no transcription now (unavailable_reason).
OFF = "off"
NOT_READY = "not_ready"
USER_LYRICS = "user_lyrics"
NO_VOCALS = "no_vocals"


@dataclass
class TranscribeRun(Run):
    """One on-demand transcription, for GET .../lyrics/transcribe: RUNNING
    until it ends DONE, NO_SINGING, FAILED, HAS_LYRICS or CANCELLED."""

    cancelled_state: ClassVar[str] = CANCELLED

    # QUEUED until it holds the pipeline lock, then the worker's own phases:
    # "load", "download" (the model, first run only), "transcribe".
    phase: str = QUEUED
    device: str | None = None

    def view(self) -> dict[str, Any]:
        out: dict[str, Any] = {"state": self.state}
        if self.state == RUNNING:
            out["phase"] = self.phase
            out["progress"] = round(self.progress, 3)
        return out

    def report(self, phase: str, pct: int | None) -> None:
        self.phase = phase
        self.progress = (pct or 0) / _PERCENT


TRANSCRIBE_RUNS: RunBoard[TranscribeRun] = RunBoard(TranscribeRun)


def whisper_device_now() -> str:
    """Resolved now: the job's separation device may be stale (CPU fallback,
    jobs from before compute_device)."""
    return whisper_device(get_demucs_device())


def unavailable_reason(job: Job, job_dir: Path) -> str | None:
    """Why ``job`` cannot be transcribed now, or None when it can: OFF,
    NOT_READY, USER_LYRICS, HAS_LYRICS or NO_VOCALS. Blocking (reads the
    job's files). Too little singing is not checked here: a run ends in
    NO_SINGING for it, so the tab says so in the same place either way."""
    if get_transcribe_lyrics() == TRANSCRIBE_LYRICS_OFF:
        return OFF
    if job.status != STATUS_DONE:
        return NOT_READY
    if lyrics_path(job_dir).is_file():
        entry = read_lyrics(job_dir)
        return USER_LYRICS if entry is not None and entry["source"] == USER_SOURCE else HAS_LYRICS
    if not (job_dir / "stems" / "vocals.wav").is_file():
        return NO_VOCALS
    return None


def _keep(
    job: Job,
    job_dir: Path,
    entry: dict[str, Any],
    cancelled: Callable[[], bool],
) -> str:
    """Write ``entry`` as the job's lyrics unless it has some by now."""
    with _OFFSET_LOCK:
        if cancelled():
            raise JobCancelled()
        if lyrics_path(job_dir).is_file():
            return HAS_LYRICS
        return DONE if write_lyrics(job, job_dir, entry) else FAILED


def transcribe_now(
    job: Job,
    job_dir: Path,
    *,
    device: str,
    cancelled: Callable[[], bool],
    report: Callable[[str, int | None], None],
) -> str:
    """Transcribe the job's vocals into lyrics.json, and say how it ended:
    DONE, NO_SINGING (the vocal-presence gate, or too few words heard),
    FAILED or HAS_LYRICS. Blocking: runs a worker for up to minutes. Raises
    JobCancelled when ``cancelled()`` turned true; nothing is written then.
    ``report`` hears the worker's phases and percentages."""
    reason = _vocals_reason(job, job_dir)
    if reason is not None:
        logger.info("[%s] lyrics not transcribed: %s", job.id, reason)
        return NO_SINGING
    # Looked up on the module, where tests put their stub worker.
    cmd = transcribe._spawn_worker_cmd(job_dir / "stems" / "vocals.wav", device)
    result = _run_worker(job, cmd, cancelled=cancelled, report=report)
    if result is None:
        return FAILED
    entry = build_lyrics(result, job)
    if entry is None:
        logger.info("[%s] lyrics transcription heard no words", job.id)
        return NO_SINGING
    state = _keep(job, job_dir, entry, cancelled)
    logger.info(
        "[%s] lyrics transcribed on demand: %s, model=%s device=%s language=%s",
        job.id,
        state,
        result.get("model"),
        result.get("device"),
        result.get("language"),
    )
    return state
