"""Rebuilding a song from its folder when registry.json has no entry for it."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from app.core.config import (
    EXTRA_STEM_NAMES,
    LYRICS_FILE,
    STEM_FORMAT_CHOICES,
    STEM_MP3_KBPS_CHOICES,
    STEM_NAMES,
    UPLOAD_EXTS,
)
from app.core.models import (
    STATUS_DONE,
    VOCAL_SPLIT_CHOICE_COMBINED,
    VOCAL_SPLIT_CHOICE_SPLIT,
    VOCAL_SPLIT_DONE,
    VOCAL_SPLIT_ERROR,
    VOCAL_SPLIT_NONE,
    Job,
    VocalSplitChoice,
    VocalSplitFailure,
    VocalSplitState,
    clean_artist,
    clean_audio_tags,
    clean_identity,
    clean_user_name,
    clean_work,
)
from app.core.song_folder import (
    STEMS_COMPLETE,
    backfill_stems_complete,
    copy_saved_fields,
    is_real_entry,
    is_started_only,
    read_metadata,
    saved_from_meta,
    write_json_atomic,
)
from app.core.stem_files import stem_exists, stem_url

logger = logging.getLogger("stemdeck.registry")

# How much of the id a rebuilt song's placeholder title shows.
_RECOVERED_ID_CHARS = 6


def recovered_title(job_id: str) -> str:
    """The placeholder title of a song rebuilt without its name."""
    return f"Recovered track {job_id[:_RECOVERED_ID_CHARS]}"


def _upload_source(job_dir: Path) -> Path | None:
    """The file Extract would run (the first source.*, as
    jobqueue._find_local_source picks it), when an upload can be that type."""
    try:
        if not is_real_entry(job_dir) or not all(is_real_entry(p) for p in job_dir.iterdir()):
            return None  # Extract would write through the link.
        source = next((p for p in sorted(job_dir.glob("source.*")) if p.is_file()), None)
    except OSError:
        logger.warning("could not read %s", job_dir.name, exc_info=True)
        return None
    return source if source is not None and source.suffix.lower() in UPLOAD_EXTS else None


def stopped_from_source(job_dir: Path) -> Job | None:
    """A song stopped before it was separated, rebuilt from the source it kept
    (upstream PR 889): without stems it stayed out of reach of Extract."""
    source = _upload_source(job_dir)
    if source is None:
        return None
    title = recovered_title(job_dir.name)
    logger.warning("%s holds a source that was never separated; kept as stopped", job_dir.name)
    meta = read_metadata(job_dir / "metadata.json")
    added = saved_from_meta(meta, ("created_at",)) if isinstance(meta, dict) else {}
    return Job(
        id=job_dir.name,
        status="stopped",
        stage_message="Stopped",
        title=title,
        source_url=f"local:{title}",
        source_format=source.suffix[1:].lower(),
        selected_stems=list(STEM_NAMES),
        created_at=added.get("created_at", job_dir.stat().st_mtime),
    )


def _disk_stems(job_dir: Path) -> list[dict[str, str]]:
    """The stems a song's folder holds, Lead + Backing both or neither: the
    worker writes the pair one file at a time, and a kill between them leaves
    a lead alone (upstream PR 901)."""
    stems_dir = job_dir / "stems"
    has_split = all(stem_exists(stems_dir, name) for name in EXTRA_STEM_NAMES)
    return [
        {"name": name, "url": stem_url(job_dir.name, stems_dir, name)}
        for name in ("original", *STEM_NAMES, *(EXTRA_STEM_NAMES if has_split else ()))
        if stem_exists(stems_dir, name)
    ]


def _finished_meta(job_dir: Path, legacy: bool) -> dict | None:
    """The metadata.json of a folder whose separation finished, or None. A file
    with only the add time is from before the song was done (keep_added_time)."""
    meta_path = job_dir / "metadata.json"
    meta = read_metadata(meta_path)
    finished = meta_path.is_file() and not is_started_only(meta)
    # Current code writes metadata.json before it separates, so stems with none
    # at all, or in a version 1 library, are from before the marker: done.
    older = legacy or not meta_path.exists()
    marked = older or (job_dir / "stems" / STEMS_COMPLETE).is_file()
    if not marked and not finished:
        logger.warning("%s holds stems of a separation that did not finish", job_dir.name)
        return None
    if not isinstance(meta, dict):
        meta = {}  # read as none, so the folders after this one still rebuild
    if not finished:
        # Crash window (#284): the process died between the marker and the
        # metadata write. Recover with a placeholder title and write it beside
        # the add time now, so the NEXT restart takes the normal path.
        meta["title"] = recovered_title(job_dir.name)
        try:
            write_json_atomic(meta_path, meta)
        except OSError:
            logger.warning("could not write recovery metadata for %s", job_dir.name, exc_info=True)
    return meta


def recover_done_job(job_dir: Path, legacy: bool = False) -> Job | None:
    """A finished song rebuilt from its folder, or None for a folder whose
    separation did not finish (upstream PR 901)."""
    stems_dir = job_dir / "stems"
    if not stems_dir.is_dir():
        return None
    stems = _disk_stems(job_dir)
    if not stems:
        return None
    meta = _finished_meta(job_dir, legacy)
    if meta is None:
        return None
    mix_url = None
    if stem_exists(stems_dir, "mix"):
        mix_url = stem_url(job_dir.name, stems_dir, "mix")
    selected = [stem["name"] for stem in stems if stem["name"] in STEM_NAMES] or list(STEM_NAMES)
    # A restart between the split finishing and its next registry persist
    # would otherwise report the job as never split -- derive from disk the
    # same way `stems` above does, so the recovered library entry doesn't
    # regress (#275).
    vocal_split, vocal_split_choice, vocal_split_error = _recovered_vocal_split(stems_dir)
    job = Job(
        id=job_dir.name,
        status="done",
        progress=1.0,
        stage_message="Done",
        stems=stems,
        selected_stems=selected,
        mix_url=mix_url,
        created_at=job_dir.stat().st_mtime,
        title=meta.get("title"),
        user_title=clean_user_name(meta.get("user_title")),
        user_artist=clean_user_name(meta.get("user_artist")),
        thumbnail=meta.get("thumbnail"),
        duration_sec=meta.get("duration_sec"),
        bpm=meta.get("bpm"),
        key=meta.get("key"),
        scale=meta.get("scale"),
        key_confidence=meta.get("key_confidence"),
        lufs=meta.get("lufs"),
        peak_db=meta.get("peak_db"),
        dynamic_range=meta.get("dynamic_range"),
        tempo_stability=meta.get("tempo_stability"),
        stem_presence=meta.get("stem_presence"),
        sections=meta.get("sections"),
        sections_source=meta.get("sections_source"),
        tags=meta.get("tags"),
        audio_tags=clean_audio_tags(meta.get("audio_tags")),
        identity=clean_identity(meta.get("identity")),
        artist=clean_artist(meta.get("artist")),
        user_band=clean_artist(meta.get("user_band")),
        work=clean_work(meta.get("work")),
        # The file is the record: metadata.json predates it for most jobs.
        has_lyrics=(job_dir / LYRICS_FILE).is_file(),
        vocal_split=vocal_split,
        vocal_split_choice=vocal_split_choice,
        vocal_split_error=vocal_split_error,
        stem_format=_choice(meta.get("stem_format"), STEM_FORMAT_CHOICES),
        stem_mp3_kbps=_choice(meta.get("stem_mp3_kbps"), STEM_MP3_KBPS_CHOICES),
    )
    for name, value in saved_from_meta(meta).items():
        setattr(job, name, value)
    return job


def _choice(value: object, choices: tuple) -> Any:
    """`value` when it is one of `choices` (a bool is never a bitrate), else None."""
    return value if not isinstance(value, bool) and value in choices else None


def _recovered_vocal_split(
    stems_dir: Path,
) -> tuple[VocalSplitState, VocalSplitChoice, VocalSplitFailure | None]:
    """The split state, choice and failure code a job's stems folder shows:
    both split stems, a failed split's error file, or neither."""
    if all(stem_exists(stems_dir, name) for name in EXTRA_STEM_NAMES):
        return VOCAL_SPLIT_DONE, VOCAL_SPLIT_CHOICE_SPLIT, None
    # Imported here: app.pipeline imports this module.
    from app.pipeline.vocal_split import read_error_code

    code = read_error_code(stems_dir)
    if code is not None:
        return VOCAL_SPLIT_ERROR, VOCAL_SPLIT_CHOICE_SPLIT, code
    return VOCAL_SPLIT_NONE, VOCAL_SPLIT_CHOICE_COMBINED, None


def migrate_song_folders(jobs: Iterable[Job], jobs_dir: Path) -> bool:
    """Once, on the first start after a version 1 library: give each finished
    song the completion marker and its SAVED_FIELDS in metadata.json, or a
    registry lost later would not bring it back whole. True when any changed."""
    done = [job for job in jobs if job.status == STATUS_DONE]
    for job in done:
        backfill_stems_complete(jobs_dir / job.id)
    copied = sum(copy_saved_fields(job, jobs_dir / job.id) for job in done)
    if copied:
        logger.info("copied saved fields into %d song folder(s)", copied)
    return copied > 0
