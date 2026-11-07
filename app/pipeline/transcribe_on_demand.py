"""Lyrics transcribed from the vocals when the user asks, for a track that has none.

transcribe.py transcribes at the end of an import, and only under the
transcribe_lyrics setting's terms ("auto": a CUDA job only). A track imported
while it was off, on a CPU under "auto", or before transcription existed, has
no lyrics and never gets any. POST .../lyrics/transcribe (app/api/transcribe.py)
asks for them here, from the Lyrics tab: on a GPU or the CPU alike, under
any setting but "off", in the background and behind the pipeline lock, like
the line-by-line timing of lyrics_retime.py, whose run machinery
(runs.RunBoard) it shares.

The result is the one an import makes: lyrics.json with source "whisper",
from build_lyrics. When the vocals already have a transcript kept beside
them (lyrics_retime.save_transcript, by a timing or an accent mend), its
words are used and no model runs; a new transcript is kept the same way.

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

from app.core.models import Job, JobCancelled
from app.core.settings import get_transcribe_lyrics
from app.pipeline import transcribe
from app.pipeline.lyrics_lookup import (
    _OFFSET_LOCK,
    USER_SOURCE,
    lyrics_path,
    read_lyrics,
    write_lyrics,
)
from app.pipeline.lyrics_retime import read_transcript, save_transcript
from app.pipeline.runs import Run, RunBoard
from app.pipeline.transcribe import _device, _run_worker, _vocals_reason, build_lyrics

logger = logging.getLogger("stemdeck.transcribe")

DONE = "done"
NO_SINGING = "no_singing"
FAILED = "failed"
HAS_LYRICS = "has_lyrics"

# Why a track gets no transcription now (unavailable_reason).
OFF = "off"
NOT_READY = "not_ready"
USER_LYRICS = "user_lyrics"
NO_VOCALS = "no_vocals"


@dataclass
class TranscribeRun(Run):
    """One on-demand transcription, for GET .../lyrics/transcribe: "running"
    until it ends DONE, NO_SINGING, FAILED, HAS_LYRICS or "cancelled"."""

    cancelled_state: ClassVar[str] = "cancelled"

    # "queued" until it holds the pipeline lock, then the worker's own
    # phases: "load", "download" (the model, first run only), "transcribe".
    phase: str = "queued"

    def view(self) -> dict[str, Any]:
        out: dict[str, Any] = {"state": self.state}
        if self.state == "running":
            out["phase"] = self.phase
            out["progress"] = round(self.progress, 3)
        return out

    def report(self, phase: str, pct: int | None) -> None:
        self.phase = phase
        self.progress = (pct or 0) / 100


_BOARD: RunBoard[TranscribeRun] = RunBoard(TranscribeRun)
claim_run = _BOARD.claim
current_run = _BOARD.current
cancel_run = _BOARD.cancel
wait_run_ended = _BOARD.wait_ended
forget_run = _BOARD.forget


def device(job: Job) -> str:
    """Where a run for ``job`` goes: "cuda" or "cpu" (transcribe._device)."""
    return _device(job)


def unavailable_reason(job: Job, job_dir: Path) -> str | None:
    """Why ``job`` cannot be transcribed now, or None when it can: OFF,
    NOT_READY, USER_LYRICS, HAS_LYRICS or NO_VOCALS. Blocking (reads the
    job's files). Too little singing is not checked here: a run ends in
    NO_SINGING for it, so the tab says so in the same place either way."""
    if get_transcribe_lyrics() == "off":
        return OFF
    if job.status != "done":
        return NOT_READY
    if lyrics_path(job_dir).is_file():
        entry = read_lyrics(job_dir)
        return USER_LYRICS if entry is not None and entry["source"] == USER_SOURCE else HAS_LYRICS
    if not (job_dir / "stems" / "vocals.wav").is_file():
        return NO_VOCALS
    return None


def _kept_answer(job_dir: Path) -> dict[str, Any] | None:
    """A kept transcript of these vocals as a worker answer of one segment,
    or None when there is none. Its words were kept by the looser rule of
    transcript_words, which drops only what Whisper took for silence."""
    kept = read_transcript(job_dir)
    if kept is None or not kept["words"]:
        return None
    words = [{"word": w["text"], "start": w["start"], "end": w["end"]} for w in kept["words"]]
    return {"segments": [{"words": words}], "language": kept["language"], "model": "kept"}


def _heard(
    job: Job,
    job_dir: Path,
    cancelled: Callable[[], bool],
    report: Callable[[str, int | None], None],
) -> dict[str, Any] | None:
    """The worker's answer for the vocals, or the kept transcript's; None
    when the worker failed. Raises JobCancelled."""
    kept = _kept_answer(job_dir)
    if kept is not None:
        return kept
    vocals = job_dir / "stems" / "vocals.wav"
    # Looked up on the module, where tests put their stub worker.
    cmd = transcribe._spawn_worker_cmd(vocals, _device(job))
    result = _run_worker(job, cmd, cancelled=cancelled, report=report)
    if result is not None:
        save_transcript(job_dir, result)
    return result


def _keep(job: Job, job_dir: Path, entry: dict[str, Any], cancelled: Callable[[], bool]) -> str:
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
    cancelled: Callable[[], bool],
    report: Callable[[str, int | None], None],
) -> str:
    """Transcribe the job's vocals into lyrics.json, and say how it ended:
    DONE, NO_SINGING (the vocal-presence gate, or too few words heard),
    FAILED or HAS_LYRICS. Blocking: may run a worker for minutes. Raises
    JobCancelled when ``cancelled()`` turned true; nothing is written then.
    ``report`` hears the worker's phases and percentages."""
    reason = _vocals_reason(job, job_dir)
    if reason is not None:
        logger.info("[%s] lyrics not transcribed: %s", job.id, reason)
        return NO_SINGING
    result = _heard(job, job_dir, cancelled, report)
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
