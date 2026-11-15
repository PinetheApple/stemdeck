"""The test encode that decides whether an H.264 encoder works here, and the
cache of its answers.

`ffmpeg -encoders` is not trusted: a build lists NVENC on a machine whose GPU
it cannot open (measured in the agent sandbox: CUDA_ERROR_NO_DEVICE). A probe
encodes a moving test picture plus silence at the render's own size and rate
with the render's own arguments, writes a real MP4, and passes it through
validate_output. Only that counts as a pass.

Results are cached in memory and in DATA_DIR/video_encoders.json, keyed by the
ffmpeg binary's identity (path, size, mtime, version), the encoder, the
geometry, a fingerprint of the arguments and, for VAAPI, the render node and
the PCI ids of the GPU behind it. A pass lasts a week, a failure a day, a
timeout or a busy device ten minutes; a cancelled probe is never kept.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from app.core.config import DATA_DIR, ffmpeg_executable
from app.core.song_folder import write_json_atomic
from app.core.video_config import (
    ERROR_LINE_MAX_CHARS,
    IDENTITY_HEX_CHARS,
    LOGGER_NAME,
    TIMEOUT_VIDEO_ENCODER_PROBE,
    VERSION_LINE_MAX_CHARS,
    VIDEO_ENCODER_CACHE_FILE,
    VIDEO_ENCODER_CACHE_VERSION,
    VIDEO_ENCODER_FAIL_TTL_SEC,
    VIDEO_ENCODER_PASS_TTL_SEC,
    VIDEO_ENCODER_PROBE_SEC,
    VIDEO_ENCODER_RETRY_SEC,
    VIDEO_TEST_AUDIO_RATE,
)
from app.pipeline.video_encoder_args import (
    encoder_args,
    global_args,
    gpu_id,
    output_filter,
    variant_count,
)
from app.pipeline.video_validate import (
    STOP_CANCELLED,
    STOP_TIMEOUT,
    OutputInvalid,
    ProcessStopped,
    never,
    run_watched,
    validate_output,
)

logger = logging.getLogger(LOGGER_NAME)

CACHE_PATH = DATA_DIR / VIDEO_ENCODER_CACHE_FILE

REASON_MISSING = "missing"
REASON_NO_DEVICE = "no-device"
REASON_BUSY = "busy"
REASON_FAILED = "failed"
REASON_ERROR = "error"
CODE_EXIT = "exit"
INVALID_PREFIX = "invalid-"
# Another argument set cannot help with these.
_FINAL_REASONS = (REASON_MISSING, REASON_NO_DEVICE, REASON_ERROR, STOP_TIMEOUT, STOP_CANCELLED)

_MISSING_RE = re.compile(r"unknown encoder|encoder not found", re.IGNORECASE)
_NO_DEVICE_RE = re.compile(
    r"no cuda-capable device|cuda_error_no_device|no va display|no device available|"
    r"device creation failed|cannot load libcuda|cannot load nvcuda|no nvenc capable",
    re.IGNORECASE,
)
# A device that is there but taken or short of memory right now.
_TRANSIENT_RE = re.compile(
    r"out of memory|busy|temporarily unavailable|incompatible client key|too many|no free|try again",
    re.IGNORECASE,
)
# Failures over the files, not the encoder: the system's own words.
_FILES_RE = re.compile(
    r"no space left on device|disk quota exceeded|file too large|no such file or directory|"
    r"permission denied|input/output error|read-only file system|error opening input",
    re.IGNORECASE,
)
_NOISE_RE = re.compile(
    r"could not open encoder before eof|task finished with error|terminating thread|"
    r"nothing was written|error while filtering|error opening output|conversion failed|^\s*$",
    re.IGNORECASE,
)
_PREFIX_RE = re.compile(r"^(\[[^\]]*\]\s*)+")
_ADDRESS_RE = re.compile(r"0x[0-9a-fA-F]+")
_PRINTABLE_MIN = 32
_PRINTABLE_END = 127
_MIN_WALL_SEC = 1e-3
_SPEED_DECIMALS = 2


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
        """What the Settings table shows: the node's name, never a path."""
        out = asdict(self)
        out.pop("checked_at")
        out["device"] = Path(self.device).name if self.device else ""
        return out


def clean_error_line(stderr: str) -> str:
    """The most telling line of an ffmpeg error, without "[enc @ 0x...]"
    prefixes or addresses, printable ASCII, capped in length."""
    lines = [ln.strip() for ln in stderr.splitlines() if ln.strip()]
    pick = next((ln for ln in lines if not _NOISE_RE.search(ln)), lines[0] if lines else "")
    pick = _ADDRESS_RE.sub("", _PREFIX_RE.sub("", pick))
    pick = "".join(c for c in pick if _PRINTABLE_MIN <= ord(c) < _PRINTABLE_END).strip()
    return pick[:ERROR_LINE_MAX_CHARS]


def classify_failure(stderr: str) -> tuple[str, bool]:
    """(reason, transient) for an encode that exited non-zero."""
    if _MISSING_RE.search(stderr):
        return REASON_MISSING, False
    if _NO_DEVICE_RE.search(stderr):
        return REASON_NO_DEVICE, False
    if _TRANSIENT_RE.search(stderr):
        return REASON_BUSY, True
    return REASON_FAILED, False


def blames_encoder(encoder: str, code: str, stderr: str) -> bool:
    """Whether a failed GPU render counts toward switching the encoder off.
    A stall, a timeout and a file that fails its check always count. An exit
    counts only when the encoder said so itself, on a failure that is neither
    about the files nor a busy device: a wrong count turns the encoder off
    until restart, a missed one costs one quick GPU attempt."""
    if code != CODE_EXIT:
        return True
    if _FILES_RE.search(stderr):
        return False
    reason, transient = classify_failure(stderr)
    if transient:
        return False
    if reason in (REASON_MISSING, REASON_NO_DEVICE):
        return True
    own = re.compile(rf"\[(?:enc:)?{re.escape(encoder)} @", re.IGNORECASE)
    return own.search(stderr) is not None


_ident_cache: dict[tuple[str, int, int], tuple[str, str]] = {}


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


def ffmpeg_identity() -> tuple[str, str]:
    """(id, version line) of the ffmpeg this process runs; a new binary gets a
    new id, which drops every cached result. ("", "") with no binary."""
    exe = ffmpeg_executable()
    path = os.path.abspath(exe) if os.path.isfile(exe) else shutil.which(exe)
    if path is None:
        return "", ""
    try:
        st = os.stat(path)
    except OSError:
        return "", ""
    key = (path, st.st_size, st.st_mtime_ns)
    if key not in _ident_cache:
        version = _version_line(path)
        if not version:
            return "", ""
        digest = hashlib.sha256(
            f"{path}|{st.st_size}|{st.st_mtime_ns}|{version}".encode()
        ).hexdigest()
        _ident_cache[key] = (digest[:IDENTITY_HEX_CHARS], version)
    return _ident_cache[key]


def probe_cmd(
    encoder: str,
    width: int,
    height: int,
    fps: int,
    variant: int,
    device: str,
    dest: Path,
) -> list[str]:
    """A real encode of a moving test picture and silence, muxed as the render
    muxes, at the render's geometry and with its arguments."""
    seconds = VIDEO_ENCODER_PROBE_SEC
    return [
        *[ffmpeg_executable(), "-nostdin", "-hide_banner", "-v", "error", "-y"],
        *global_args(encoder, device),
        *["-f", "lavfi", "-i", f"testsrc2=s={width}x{height}:r={fps}:d={seconds}"],
        *["-f", "lavfi", "-i", f"anullsrc=r={VIDEO_TEST_AUDIO_RATE}:cl=stereo:d={seconds}"],
        *["-vf", output_filter(encoder)],
        *encoder_args(encoder, width, height, fps, variant),
        *["-r", str(fps), "-c:a", "aac", "-shortest", "-f", "mp4", str(dest)],
    ]


def _encode_test(base: dict, dest: Path, cancelled: Callable[[], bool]) -> ProbeResult | None:
    """Run the test encode; a failed result, or None when ffmpeg exited 0."""
    cmd = probe_cmd(
        base["encoder"],
        base["width"],
        base["height"],
        base["fps"],
        base["variant"],
        base["device"],
        dest,
    )
    try:
        rc, _out, err = run_watched(cmd, TIMEOUT_VIDEO_ENCODER_PROBE, cancelled)
    except ProcessStopped as exc:
        return ProbeResult(**base, ok=False, reason=exc.reason, transient=True)
    except OSError as exc:
        detail = type(exc).__name__
        return ProbeResult(**base, ok=False, reason=REASON_ERROR, detail=detail, transient=True)
    if rc == 0:
        return None
    reason, transient = classify_failure(err)
    detail = clean_error_line(err)
    return ProbeResult(**base, ok=False, reason=reason, detail=detail, transient=transient)


def _check_test(base: dict, dest: Path, cancelled: Callable[[], bool]) -> ProbeResult | None:
    """The output check of the test file; a failed result, or None."""
    try:
        validate_output(
            dest,
            base["width"],
            base["height"],
            base["fps"],
            VIDEO_ENCODER_PROBE_SEC,
            cancelled,
        )
    except OutputInvalid as exc:
        stopped = exc.code in (STOP_TIMEOUT, STOP_CANCELLED)
        reason = exc.code if stopped else INVALID_PREFIX + exc.code
        return ProbeResult(**base, ok=False, reason=reason, detail=str(exc), transient=stopped)
    return None


def _attempt(base: dict, dest: Path, cancelled: Callable[[], bool]) -> ProbeResult:
    start = time.monotonic()
    failed = _encode_test(base, dest, cancelled)
    if failed is not None:
        return failed
    wall = max(time.monotonic() - start, _MIN_WALL_SEC)
    failed = _check_test(base, dest, cancelled)
    if failed is not None:
        return failed
    speed = round(VIDEO_ENCODER_PROBE_SEC / wall, _SPEED_DECIMALS)
    return ProbeResult(**base, ok=True, speed=speed)


def _run_once(
    encoder: str,
    width: int,
    height: int,
    fps: int,
    variant: int,
    device: str,
    cancelled: Callable[[], bool],
) -> ProbeResult:
    base = {"encoder": encoder, "width": width, "height": height, "fps": fps}
    base.update(variant=variant, device=device, checked_at=now())
    with tempfile.TemporaryDirectory(prefix="stemdeck-probe-") as tmp:
        return _attempt(base, Path(tmp) / "probe.mp4", cancelled)


def run_probe(
    encoder: str,
    width: int,
    height: int,
    fps: int,
    device: str = "",
    cancelled: Callable[[], bool] = never,
) -> ProbeResult:
    """Probe each argument set of `encoder` in order (on render node `device`
    for VAAPI); the first pass wins, else the last failure is the answer."""
    result = _run_once(encoder, width, height, fps, 0, device, cancelled)
    for variant in range(1, variant_count(encoder)):
        if result.ok or result.reason in _FINAL_REASONS:
            break
        result = _run_once(encoder, width, height, fps, variant, device, cancelled)
    return result


_cache: dict[str, ProbeResult] = {}
_cache_ident: str | None = None
_cache_lock = threading.RLock()
_probe_lock = threading.Lock()
_FIELDS = {f.name for f in fields(ProbeResult)}


def _args_sig(encoder: str, width: int, height: int, fps: int, device: str) -> str:
    sets = [encoder_args(encoder, width, height, fps, v) for v in range(variant_count(encoder))]
    raw = json.dumps([sets, global_args(encoder, device), output_filter(encoder)])
    return hashlib.sha256(raw.encode()).hexdigest()[:IDENTITY_HEX_CHARS]


def _key(encoder: str, width: int, height: int, fps: int, device: str) -> str:
    sig = _args_sig(encoder, width, height, fps, device)
    return "|".join((encoder, f"{width}x{height}@{fps}", sig, device, gpu_id(device)))


def _read_cache_file(ident: str) -> dict[str, ProbeResult]:
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("video encoder cache unreadable; starting afresh", exc_info=True)
        return {}
    if (
        not isinstance(data, dict)
        or data.get("v") != VIDEO_ENCODER_CACHE_VERSION
        or data.get("ffmpeg") != ident
    ):
        return {}
    results = data.get("results")
    if not isinstance(results, dict):
        return {}
    return {
        k: ProbeResult(**{f: v[f] for f in _FIELDS if f in v})
        for k, v in results.items()
        if isinstance(v, dict)
    }


def _ensure_loaded(ident: str) -> None:
    global _cache_ident
    if _cache_ident == ident:
        return
    try:
        loaded = _read_cache_file(ident)
    except TypeError:
        loaded = {}
    _cache.clear()
    _cache.update(loaded)
    _cache_ident = ident


def _save() -> None:
    data = {
        "v": VIDEO_ENCODER_CACHE_VERSION,
        "ffmpeg": _cache_ident,
        "results": {k: asdict(r) for k, r in _cache.items()},
    }
    try:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(CACHE_PATH, data)
    except OSError:
        logger.warning("video encoder cache not saved", exc_info=True)


def probe(
    encoder: str,
    width: int,
    height: int,
    fps: int,
    device: str = "",
    force: bool = False,
    cancelled: Callable[[], bool] = never,
) -> ProbeResult:
    """The cached answer for this encoder and geometry while it lasts, else a
    fresh probe, which is cached unless it was cancelled. Blocking."""
    ident, _version = ffmpeg_identity()
    key = _key(encoder, width, height, fps, device)
    with _probe_lock:
        with _cache_lock:
            _ensure_loaded(ident)
            hit = _cache.get(key)
        if hit is not None and not force and now() < hit.expires_at():
            return hit
        result = run_probe(encoder, width, height, fps, device=device, cancelled=cancelled)
        if result.reason != STOP_CANCELLED:
            with _cache_lock:
                _cache[key] = result
                _save()
    logger.info(
        "probe %s %dx%d@%d%s: %s",
        encoder,
        width,
        height,
        fps,
        f" on {device}" if device else "",
        result.reason or "ok",
    )
    return result


def drop_passes(encoder: str, device: str = "") -> None:
    """Forget the cached passes of an encoder (of one VAAPI node when `device`
    is given) after it failed a real render."""
    with _cache_lock:
        gone = [
            k
            for k, r in _cache.items()
            if r.ok and r.encoder == encoder and (not device or r.device == device)
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
