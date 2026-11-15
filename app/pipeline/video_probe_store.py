"""What a probe found, and where it is kept: in memory and in
DATA_DIR/video_encoders.json, keyed by the ffmpeg binary (path, size, mtime,
version), the encoder, the geometry, a fingerprint of the arguments and, for
VAAPI, the render node and the PCI ids of the GPU behind it."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from app.core.config import DATA_DIR, ffmpeg_executable
from app.core.song_folder import write_json_atomic
from app.core.video_config import (
    IDENTITY_HEX_CHARS,
    LOGGER_NAME,
    TIMEOUT_VIDEO_ENCODER_PROBE,
    VERSION_LINE_MAX_CHARS,
    VIDEO_ENCODER_CACHE_FILE,
    VIDEO_ENCODER_CACHE_VERSION,
    VIDEO_ENCODER_FAIL_TTL_SEC,
    VIDEO_ENCODER_PASS_TTL_SEC,
    VIDEO_ENCODER_RETRY_SEC,
)
from app.pipeline.video_encoder_args import (
    encoder_args,
    global_args,
    gpu_id,
    output_filter,
    variant_count,
)

logger = logging.getLogger(LOGGER_NAME)

CACHE_PATH = DATA_DIR / VIDEO_ENCODER_CACHE_FILE
CACHE_KEY_VERSION = "v"
CACHE_KEY_FFMPEG = "ffmpeg"
CACHE_KEY_RESULTS = "results"


def now() -> float:
    return time.time()


@dataclass
class ProbeResult:
    encoder: str
    width: int
    height: int
    fps: int
    ok: bool
    reason: str = ""
    detail: str = ""
    speed: float | None = None
    variant: int = 0
    device: str = ""
    checked_at: float = 0.0
    transient: bool = False

    def expires_at(self) -> float:
        if self.ok:
            return self.checked_at + VIDEO_ENCODER_PASS_TTL_SEC
        ttl = VIDEO_ENCODER_RETRY_SEC if self.transient else VIDEO_ENCODER_FAIL_TTL_SEC
        return self.checked_at + ttl

    def view(self) -> dict:
        """A row of the Settings test table: the node's name, never a path."""
        out = asdict(self)
        out.pop("checked_at")
        out["device"] = Path(self.device).name if self.device else ""
        return out


@dataclass(frozen=True)
class ProbeTarget:
    """One test encode: an encoder, its argument set and node, a geometry."""

    encoder: str
    width: int
    height: int
    fps: int
    variant: int = 0
    device: str = ""

    def result(self, ok: bool, **outcome: object) -> ProbeResult:
        return ProbeResult(
            self.encoder,
            self.width,
            self.height,
            self.fps,
            ok=ok,
            variant=self.variant,
            device=self.device,
            checked_at=now(),
            **outcome,
        )


_ident_cache: dict[tuple[str, int, int], str] = {}


def _version_line(path: str) -> str:
    try:
        out = subprocess.run(  # noqa: S603 -- fixed args, trusted ffmpeg
            [path, "-hide_banner", "-version"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=TIMEOUT_VIDEO_ENCODER_PROBE,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        logger.debug("ffmpeg -version failed", exc_info=True)
        return ""
    line = (out.stdout.splitlines() or [""])[0].strip()
    return line[:VERSION_LINE_MAX_CHARS] if out.returncode == 0 else ""


def ffmpeg_identity() -> str:
    """An id of the ffmpeg this process runs; a new binary gets a new id,
    which drops every cached answer. "" with no binary."""
    exe = ffmpeg_executable()
    path = os.path.abspath(exe) if os.path.isfile(exe) else shutil.which(exe)
    if path is None:
        return ""
    try:
        st = os.stat(path)
    except OSError:
        return ""
    key = (path, st.st_size, st.st_mtime_ns)
    if key not in _ident_cache:
        version = _version_line(path)
        if not version:
            return ""
        raw = f"{path}|{st.st_size}|{st.st_mtime_ns}|{version}"
        _ident_cache[key] = hashlib.sha256(raw.encode()).hexdigest()[:IDENTITY_HEX_CHARS]
    return _ident_cache[key]


_cache: dict[str, ProbeResult] = {}
_cache_ident: str | None = None
_cache_lock = threading.RLock()
_FIELDS = {f.name for f in fields(ProbeResult)}


def cache_key(target: ProbeTarget) -> str:
    sets = [
        encoder_args(target.encoder, target.width, target.height, target.fps, v)
        for v in range(variant_count(target.encoder))
    ]
    args = json.dumps(
        [sets, global_args(target.encoder, target.device), output_filter(target.encoder)]
    )
    sig = hashlib.sha256(args.encode()).hexdigest()[:IDENTITY_HEX_CHARS]
    geometry = f"{target.width}x{target.height}@{target.fps}"
    return "|".join((target.encoder, geometry, sig, target.device, gpu_id(target.device)))


def _parse_cache(data: object, ident: str) -> dict[str, ProbeResult]:
    if not isinstance(data, dict) or data.get(CACHE_KEY_VERSION) != VIDEO_ENCODER_CACHE_VERSION:
        return {}
    results = data.get(CACHE_KEY_RESULTS)
    if data.get(CACHE_KEY_FFMPEG) != ident or not isinstance(results, dict):
        return {}
    return {
        key: ProbeResult(**{f: row[f] for f in _FIELDS if f in row})
        for key, row in results.items()
        if isinstance(row, dict)
    }


def _read_cache_file(ident: str) -> dict[str, ProbeResult]:
    try:
        return _parse_cache(json.loads(CACHE_PATH.read_text(encoding="utf-8")), ident)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError, TypeError):
        logger.warning("video encoder cache unreadable; starting afresh", exc_info=True)
        return {}


def _ensure_loaded(ident: str) -> None:
    global _cache_ident
    if _cache_ident != ident:
        _cache.clear()
        _cache.update(_read_cache_file(ident))
        _cache_ident = ident


def _save() -> None:
    data = {
        CACHE_KEY_VERSION: VIDEO_ENCODER_CACHE_VERSION,
        CACHE_KEY_FFMPEG: _cache_ident,
        CACHE_KEY_RESULTS: {key: asdict(result) for key, result in _cache.items()},
    }
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(CACHE_PATH, data)
    except OSError:
        logger.warning("video encoder cache not saved", exc_info=True)


def fresh_hit(key: str) -> ProbeResult | None:
    with _cache_lock:
        _ensure_loaded(ffmpeg_identity())
        hit = _cache.get(key)
    return hit if hit is not None and now() < hit.expires_at() else None


def cached_results() -> list[ProbeResult]:
    """Every answer still in force for the ffmpeg this process runs."""
    with _cache_lock:
        _ensure_loaded(ffmpeg_identity())
        results = list(_cache.values())
    return [r for r in results if now() < r.expires_at()]


def store(key: str, result: ProbeResult) -> None:
    with _cache_lock:
        _cache[key] = result
        _save()


def drop_passes(encoder: str, device: str = "") -> None:
    """Forget the cached passes of an encoder (of one VAAPI node when `device`
    is given) after it failed a real render."""
    with _cache_lock:
        gone = [
            key
            for key, result in _cache.items()
            if result.ok and result.encoder == encoder and (not device or result.device == device)
        ]
        for key in gone:
            del _cache[key]
        if gone:
            _save()


def reset_cache() -> None:
    """Forget the in-memory cache, so the next probe reads the file again."""
    global _cache_ident
    with _cache_lock:
        _cache.clear()
        _cache_ident = None
