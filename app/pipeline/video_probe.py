"""The test encode that decides whether an H.264 encoder works here.

`ffmpeg -encoders` lists encoders the machine cannot open, so it is not
trusted. A probe encodes a moving test picture plus silence at the render's
own size and rate with the render's own arguments, writes a real MP4 and
passes it through validate_output and check_moving_picture. Only that counts.
Answers are kept by video_probe_store: a pass for a week, a failure a day, a
timeout or busy device ten minutes; a cancel or a disk problem never.
"""

from __future__ import annotations

import logging
import re
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

from app.core.config import ffmpeg_executable
from app.core.video_config import (
    AUDIO_CODEC,
    ERROR_LINE_MAX_CHARS,
    LOGGER_NAME,
    PROBE_LOCK_POLL_SEC,
    TEST_AUDIO_LAYOUT,
    TEST_AUDIO_RATE,
    TIMEOUT_VIDEO_ENCODER_PROBE,
    VIDEO_ENCODER_PROBE_SEC,
)
from app.pipeline.video_encoder_args import encoder_args, global_args, output_filter, variant_count
from app.pipeline.video_probe_store import ProbeResult, ProbeTarget, cache_key, fresh_hit, store
from app.pipeline.video_process import (
    STOP_CANCELLED,
    STOP_TIMEOUT,
    ProcessStopped,
    never,
    run_watched,
)
from app.pipeline.video_validate import (
    CHECK_FILESIZE,
    OutputInvalid,
    check_moving_picture,
    short_of_disk,
    validate_output,
)

logger = logging.getLogger(LOGGER_NAME)

REASON_MISSING = "missing"
REASON_NO_DEVICE = "no-device"
REASON_BUSY = "busy"
REASON_FAILED = "failed"
REASON_ERROR = "error"
REASON_FILES = "files"
CODE_EXIT = "exit"
INVALID_PREFIX = "invalid-"
# Another argument set cannot help with these.
_FINAL_REASONS = (
    REASON_MISSING,
    REASON_NO_DEVICE,
    REASON_ERROR,
    REASON_FILES,
    STOP_TIMEOUT,
    STOP_CANCELLED,
)
# Say nothing about the encoder: never cached, never held against it.
_NOT_ENCODER = (REASON_FILES, STOP_CANCELLED, INVALID_PREFIX + STOP_TIMEOUT)

_MISSING_RE = re.compile(r"unknown encoder|encoder not found", re.IGNORECASE)
_NO_DEVICE_RE = re.compile(
    r"no cuda-capable device|cuda_error_no_device|no va display|no device available|"
    r"device creation failed|cannot load libcuda|cannot load nvcuda|no nvenc capable",
    re.IGNORECASE,
)
# A device that is there but taken or short of memory right now.
_TRANSIENT_RE = re.compile(
    r"out of memory|busy|temporarily unavailable|incompatible client key|too many|"
    r"no free|try again",
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
    if _FILES_RE.search(stderr):
        return REASON_FILES, True
    if _MISSING_RE.search(stderr):
        return REASON_MISSING, False
    if _NO_DEVICE_RE.search(stderr):
        return REASON_NO_DEVICE, False
    if _TRANSIENT_RE.search(stderr):
        return REASON_BUSY, True
    return REASON_FAILED, False


def invalid_code(exc: OutputInvalid, path: Path) -> str:
    """The failure code of a file that failed its check: a short file on a
    nearly full disk is the disk's fault."""
    if exc.code == CHECK_FILESIZE and short_of_disk(path):
        return REASON_FILES
    return INVALID_PREFIX + exc.code


def blames_encoder(encoder: str, code: str, stderr: str) -> bool:
    """Whether a failed GPU render counts toward switching the encoder off.
    A stall, a render timeout and a file that fails its check count; a full
    disk, a cancel and a check that ran out of time do not. An exit counts
    only when the encoder said so itself: a wrong count turns it off until
    restart, a missed one costs one quick GPU attempt."""
    if code in _NOT_ENCODER:
        return False
    if code != CODE_EXIT:
        return True
    reason, transient = classify_failure(stderr)
    if transient:
        return False
    if reason in (REASON_MISSING, REASON_NO_DEVICE):
        return True
    own = re.compile(rf"\[(?:enc:)?{re.escape(encoder)} @", re.IGNORECASE)
    return own.search(stderr) is not None


def probe_cmd(target: ProbeTarget, dest: Path) -> list[str]:
    """A real encode of a moving test picture and silence, muxed as the render
    muxes, at the render's geometry and with its arguments."""
    seconds = VIDEO_ENCODER_PROBE_SEC
    picture = f"testsrc2=s={target.width}x{target.height}:r={target.fps}:d={seconds}"
    silence = f"anullsrc=r={TEST_AUDIO_RATE}:cl={TEST_AUDIO_LAYOUT}:d={seconds}"
    codec = encoder_args(target.encoder, target.width, target.height, target.fps, target.variant)
    return [
        *[ffmpeg_executable(), "-nostdin", "-hide_banner", "-v", "error", "-y"],
        *global_args(target.encoder, target.device),
        *["-f", "lavfi", "-i", picture, "-f", "lavfi", "-i", silence],
        *["-vf", output_filter(target.encoder), *codec],
        *["-r", str(target.fps), "-c:a", AUDIO_CODEC, "-shortest", "-f", "mp4", str(dest)],
    ]


def _encode_test(
    target: ProbeTarget,
    dest: Path,
    cancelled: Callable[[], bool],
) -> ProbeResult | None:
    """Run the test encode; a failed result, or None when ffmpeg exited 0."""
    try:
        rc, _out, err = run_watched(probe_cmd(target, dest), TIMEOUT_VIDEO_ENCODER_PROBE, cancelled)
    except ProcessStopped as exc:
        return target.result(False, reason=exc.reason, transient=True)
    except OSError as exc:
        return target.result(False, reason=REASON_ERROR, detail=type(exc).__name__, transient=True)
    if rc == 0:
        return None
    reason, transient = classify_failure(err)
    return target.result(False, reason=reason, detail=clean_error_line(err), transient=transient)


def _check_test(
    target: ProbeTarget,
    dest: Path,
    cancelled: Callable[[], bool],
) -> ProbeResult | None:
    """The output checks of the test file; a failed result, or None."""
    seconds = VIDEO_ENCODER_PROBE_SEC
    try:
        validate_output(dest, target.width, target.height, target.fps, seconds, cancelled)
        check_moving_picture(dest, seconds, cancelled)
    except OutputInvalid as exc:
        if exc.code in (STOP_TIMEOUT, STOP_CANCELLED):
            return target.result(False, reason=exc.code, transient=True)
        reason = invalid_code(exc, dest)
        return target.result(
            False,
            reason=reason,
            detail=str(exc),
            transient=reason == REASON_FILES,
        )
    return None


def _attempt(target: ProbeTarget, dest: Path, cancelled: Callable[[], bool]) -> ProbeResult:
    start = time.monotonic()
    failed = _encode_test(target, dest, cancelled)
    if failed is not None:
        return failed
    wall = max(time.monotonic() - start, _MIN_WALL_SEC)
    failed = _check_test(target, dest, cancelled)
    if failed is not None:
        return failed
    return target.result(True, speed=round(VIDEO_ENCODER_PROBE_SEC / wall, _SPEED_DECIMALS))


def _run_once(target: ProbeTarget, cancelled: Callable[[], bool]) -> ProbeResult:
    with tempfile.TemporaryDirectory(prefix="stemdeck-probe-") as tmp:
        return _attempt(target, Path(tmp) / "probe.mp4", cancelled)


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
    result = _run_once(ProbeTarget(encoder, width, height, fps, 0, device), cancelled)
    for variant in range(1, variant_count(encoder)):
        if result.ok or result.reason in _FINAL_REASONS:
            break
        result = _run_once(ProbeTarget(encoder, width, height, fps, variant, device), cancelled)
    return result


_probe_lock = threading.Lock()


def _wait_for_probe_lock(cancelled: Callable[[], bool]) -> bool:
    """Take the probe lock, one probe at a time; False on a cancel meanwhile."""
    while not _probe_lock.acquire(timeout=PROBE_LOCK_POLL_SEC):
        if cancelled():
            return False
    return True


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
    fresh probe, cached when it says something about the encoder. Blocking."""
    target = ProbeTarget(encoder, width, height, fps, device=device)
    key = cache_key(target)
    hit = None if force else fresh_hit(key)
    if hit is not None:
        return hit
    if not _wait_for_probe_lock(cancelled):
        return target.result(False, reason=STOP_CANCELLED, transient=True)
    try:
        hit = None if force else fresh_hit(key)
        result = hit or run_probe(encoder, width, height, fps, device=device, cancelled=cancelled)
    finally:
        _probe_lock.release()
    if hit is None:
        if result.reason not in _NOT_ENCODER:
            store(key, result)
        logger.info("probe %s %s: %s", encoder, key.split("|")[1], result.reason or "ok")
    return result
