"""Song bundle export: one finished song packed for a player outside StemDeck.

The format is defined in docs/song-bundle.md; keep the two in step. One way
only: StemDeck writes bundles and never reads one back.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import soundfile as sf
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.api.stems import (
    _ENCODE_ARGS,
    _VOCAL_DECOMPOSITION_NAMES,
    _parse_pitches,
    _read_beat_grid,
    _title_slug,
)
from app.core.config import (
    EXTRA_STEM_NAMES,
    JOB_ID_RE,
    JOBS_DIR,
    STEM_NAMES,
    TIMEOUT_FFMPEG,
    ffmpeg_executable,
)
from app.core.registry import get as registry_get
from app.pipeline.lyrics_lookup import lyrics_path

logger = logging.getLogger("stemdeck.api")

router = APIRouter(tags=["bundle"])

BUNDLE_FORMAT = "stemdeck-song-bundle"
BUNDLE_VERSION = 1
# Mirrors LANE_VOLUME_MAX in static/js/constants.js.
_LANE_VOLUME_MAX = 2.0
_BUNDLE_STEM_NAMES = (*STEM_NAMES, *EXTRA_STEM_NAMES)
# Copied as written when present. vocal_envelope.json is only made the first
# time the studio asks for it, so older songs may not have one.
_STEMS_DIR_EXTRAS = ("peaks.json", "vocal_envelope.json")


def _wanted_stems(stems: str) -> list[str]:
    """The lanes the studio has loaded, in lane order; the six separated stems
    when it names none."""
    requested = [s for s in stems.split(",") if s]
    if not requested:
        return list(STEM_NAMES)
    if not set(requested) <= set(_BUNDLE_STEM_NAMES):
        raise HTTPException(status_code=422, detail="unknown stem requested")
    if "vocals" in requested and _VOCAL_DECOMPOSITION_NAMES & set(requested):
        raise HTTPException(
            status_code=422,
            detail="vocals cannot be combined with lead_vocals/backing_vocals (same signal)",
        )
    return [name for name in _BUNDLE_STEM_NAMES if name in requested]


def _read_json(path: Path) -> dict | None:
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        logger.warning("bundle: skipping unreadable %s", path.name)
        return None
    return data if isinstance(data, dict) else None


def _lyrics(job_dir: Path) -> dict | None:
    entry = _read_json(lyrics_path(job_dir))
    if entry is None:
        return None
    # The other candidates are for picking lyrics in the studio, not for playing.
    entry.pop("others", None)
    return entry


def _parse_flags(raw: str, names: list[str], label: str) -> list[bool]:
    flags = [f for f in raw.split(",") if f]
    if not flags:
        return [False] * len(names)
    if len(flags) != len(names) or not set(flags) <= {"0", "1"}:
        raise HTTPException(status_code=422, detail=f"{label} must be 0/1 values, one per stem")
    return [f == "1" for f in flags]


def _parse_mix(
    names: list[str], volumes: str, muted: str, soloed: str, pitches: str
) -> dict[str, dict] | None:
    """The studio mix as parallel per-lane lists, or None when none was sent."""
    raw = [v for v in volumes.split(",") if v]
    if not raw:
        return None
    if len(raw) != len(names):
        raise HTTPException(status_code=422, detail="volumes must be the same length as stems")
    try:
        levels = [float(v) for v in raw]
    except ValueError:
        raise HTTPException(status_code=422, detail="volumes must be numbers") from None
    if any(v < 0 or v > _LANE_VOLUME_MAX for v in levels):
        raise HTTPException(status_code=422, detail="volume out of range")
    lanes = zip(
        names,
        levels,
        _parse_flags(muted, names, "muted"),
        _parse_flags(soloed, names, "soloed"),
        _parse_pitches(pitches, names),
        strict=True,
    )
    return {
        name: {"volume": volume, "muted": mute, "soloed": solo, "pitch": pitch}
        for name, volume, mute, solo, pitch in lanes
    }


def _shipped_mix(mix: dict[str, dict] | None, sources: list[tuple[str, Path]]) -> dict | None:
    # A lane the studio named but that has no file on disk is not in the bundle.
    if not mix:
        return None
    lanes = {name: mix[name] for name, _ in sources if name in mix}
    return {"stems": lanes} if lanes else None


def _encode_flac(src: Path, dest: Path) -> None:
    cmd = [
        ffmpeg_executable(),
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(src),
        *_ENCODE_ARGS["flac"],
        "-f",
        "flac",
        str(dest),
    ]
    proc = subprocess.run(  # noqa: S603 — list args, no shell, trusted ffmpeg
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=TIMEOUT_FFMPEG,
    )
    if proc.returncode != 0:
        tail = proc.stderr[-2000:].decode("utf-8", "replace")
        raise RuntimeError(f"ffmpeg failed for {src.name}: {tail}")


def _build_bundle(
    sources: list[tuple[str, Path]], members: dict[str, dict], manifest: dict, dest: Path
) -> None:
    """Blocking: encode the stems and write the bundle. Runs in a thread."""
    first = sf.info(str(sources[0][1]))
    manifest["sample_rate"] = first.samplerate
    manifest["channels"] = first.channels
    manifest["stems"] = [
        {"name": name, "file": f"stems/{name}.flac", "frames": sf.info(str(path)).frames}
        for name, path in sources
    ]
    manifest["files"] = sorted(members)
    with tempfile.TemporaryDirectory() as td, zipfile.ZipFile(dest, "w", zipfile.ZIP_STORED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        for name, data in members.items():
            zf.writestr(name, json.dumps(data))
        for name, path in sources:
            out = Path(td) / f"{name}.flac"
            _encode_flac(path, out)
            zf.write(out, arcname=f"stems/{name}.flac")


@router.get("/jobs/{job_id}/bundle.zip")
async def export_bundle(
    job_id: str,
    stems: str = Query(default="", description="Comma-separated lanes; default the six stems"),
    volumes: str = Query(default="", description="Linear lane volumes, parallel to stems"),
    muted: str = Query(default="", description="0/1 per lane, parallel to stems"),
    soloed: str = Query(default="", description="0/1 per lane, parallel to stems"),
    pitches: str = Query(default="", description="Semitones per lane, parallel to stems"),
) -> FileResponse:
    """Pack a finished song as a song bundle (docs/song-bundle.md).

    The query carries what only the studio knows: which lanes it shows and the
    mix as last set. A GET like every other export, so the desktop shell's
    download path can fetch it."""
    if not JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=404, detail="job not found")
    job = registry_get(job_id)
    if job is None or job.status != "done":
        raise HTTPException(status_code=404, detail="job not ready")

    jobs_root = JOBS_DIR.resolve()
    job_dir = (JOBS_DIR / job_id).resolve()
    stems_dir = job_dir / "stems"
    if not stems_dir.is_dir() or not job_dir.is_relative_to(jobs_root):
        raise HTTPException(status_code=404, detail="stems not found")

    names = _wanted_stems(stems)
    if volumes and not stems:
        raise HTTPException(status_code=422, detail="a mix needs the stems it applies to")
    mix = _parse_mix(names, volumes, muted, soloed, pitches)
    sources = [(n, stems_dir / f"{n}.wav") for n in names if (stems_dir / f"{n}.wav").is_file()]
    if not sources:
        raise HTTPException(status_code=404, detail="no stems found")

    metadata = _read_json(job_dir / "metadata.json") or {}
    members: dict[str, dict] = {"metadata.json": metadata}
    optional = {
        "beats.json": _read_beat_grid(job_id),
        "lyrics.json": _lyrics(job_dir),
        "mix.json": _shipped_mix(mix, sources),
        **{name: _read_json(stems_dir / name) for name in _STEMS_DIR_EXTRAS},
    }
    members.update({name: data for name, data in optional.items() if data is not None})

    from app.main import app_version  # deferred: app.main imports this router

    manifest = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stemdeck_version": app_version(),
        "job_id": job_id,
        "title": job.title or metadata.get("title"),
        "duration_sec": metadata.get("duration_sec"),
    }

    fd, tmp = tempfile.mkstemp(prefix="stemdeck_bundle_", suffix=".zip")
    os.close(fd)
    tmp_path = Path(tmp)
    try:
        await asyncio.to_thread(_build_bundle, sources, members, manifest, tmp_path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        logger.exception("failed to build song bundle for job %s", job_id)
        raise HTTPException(status_code=500, detail="failed to build bundle") from None

    filename = f"{_title_slug(job.title) or job_id}.stemdeck.zip"
    return FileResponse(
        tmp_path,
        media_type="application/zip",
        filename=filename,
        background=BackgroundTask(lambda: tmp_path.unlink(missing_ok=True)),
    )
