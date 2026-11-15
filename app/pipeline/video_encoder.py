"""Which H.264 encoder makes a filmed-take export, and the CPU fallback.

The policy is the `video_encoder` setting, overridden by STEMDECK_VIDEO_ENCODER
("cpu" always means libx264). A GPU encoder is used only when the policy
allows it, it passed a test encode at the render's geometry (video_probe) and
it has not been switched off this session; a render it makes that fails or
fails its check is redone on libx264.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from app.core.video_config import (
    CANDIDATES,
    ENCODER_ENV,
    LOGGER_NAME,
    POLICY_AUTO,
    POLICY_CPU,
    PROBE_LOCK_POLL_SEC,
    TEST_GEOMETRIES,
    TIMEOUT_VIDEO_GPU_STALL,
    VAAPI,
    VIDEO_CPU_ENCODER,
    VIDEO_ENCODER_CHOICES,
    VIDEO_ENCODER_MAX_FAILURES,
    VIDEO_ENCODER_TEST_BUDGET_SEC,
    VIDEO_GPU_ENCODERS,
    normalise_choice,
    os_key,
    render_timeout_sec,
)
from app.pipeline.video_encoder_args import AUTO, FAMILY, render_nodes
from app.pipeline.video_probe import (
    INVALID_PREFIX,
    REASON_NO_DEVICE,
    ProbeResult,
    blames_encoder,
    invalid_code,
    probe,
    run_probe,
)
from app.pipeline.video_probe_store import drop_passes
from app.pipeline.video_process import STOP_CANCELLED, never
from app.pipeline.video_validate import OutputInvalid, validate_output

logger = logging.getLogger(LOGGER_NAME)

REASON_POLICY = "policy"
REASON_NONE = "none"
REASON_DISABLED = "disabled"
REASON_BUDGET = "budget"
_CANCEL_CODES = (STOP_CANCELLED, INVALID_PREFIX + STOP_CANCELLED)

_active_encodes = 0
_testing = False
_gate = threading.Condition()
_warned_env_values: set[str] = set()
_failures: dict[tuple[str, str], int] = {}
_off: set[tuple[str, str]] = set()
_state_lock = threading.Lock()


class EncodeError(Exception):
    """A render command failed. `code` is "exit", "stall", "timeout" or
    "cancelled"; `stderr` is ffmpeg's, for deciding whom to blame."""

    def __init__(self, code: str, stderr: str = "") -> None:
        super().__init__(code)
        self.code = code
        self.stderr = stderr


@dataclass(frozen=True)
class Choice:
    encoder: str
    variant: int = 0
    device: str = ""
    # Why not a GPU encoder, for the log: "policy", "none", "disabled" or the
    # last probe's reason.
    reason: str = ""


@dataclass(frozen=True)
class EncodeJob:
    """One render: where it goes, its geometry and length, how to build the
    command for (encoder, variant, device) and how to run one. `run(cmd,
    timeout, stall)` raises EncodeError; `stall` is None for libx264."""

    dest: Path
    width: int
    height: int
    fps: int
    duration_sec: float
    build: Callable[[str, int, str], list[str]]
    run: Callable[[list[str], float, float | None], None]


@dataclass(frozen=True)
class EncodeOutcome:
    encoder: str
    family: str
    variant: int = 0
    device: str = ""
    fallback_reason: str | None = None


def encoder_override() -> str | None:
    """STEMDECK_VIDEO_ENCODER when it names a choice, else None."""
    raw = normalise_choice(os.environ.get(ENCODER_ENV, ""))
    if raw and raw not in VIDEO_ENCODER_CHOICES:
        if raw not in _warned_env_values:
            _warned_env_values.add(raw)
            logger.warning(
                "%s=%r is not one of %s; ignored", ENCODER_ENV, raw, VIDEO_ENCODER_CHOICES
            )
        return None
    return raw or None


def policy(setting: str = POLICY_AUTO) -> str:
    """The env override when set, else the setting ("auto" when unknown)."""
    override = encoder_override()
    if override is not None:
        return override
    return setting if setting in VIDEO_ENCODER_CHOICES else POLICY_AUTO


def try_begin_test() -> bool:
    """Start an encoder test unless one runs or an export is encoding: both
    would compete for the same device. Pair with end_test()."""
    global _testing
    with _gate:
        if _testing or _active_encodes:
            return False
        _testing = True
        return True


def end_test() -> None:
    global _testing
    with _gate:
        _testing = False
        _gate.notify_all()


@contextmanager
def encoding(cancelled: Callable[[], bool] = never) -> Iterator[None]:
    """Hold an export's place: waits for a running encoder test to end, and
    raises EncodeError("cancelled") on a cancel meanwhile."""
    global _active_encodes
    with _gate:
        while _testing:
            if cancelled():
                raise EncodeError(STOP_CANCELLED)
            _gate.wait(timeout=PROBE_LOCK_POLL_SEC)
        _active_encodes += 1
    try:
        yield
    finally:
        with _gate:
            _active_encodes -= 1
            _gate.notify_all()


def _state_key(encoder: str, device: str) -> tuple[str, str]:
    return encoder, device if encoder == VAAPI else ""


def record_failure(encoder: str, reason: str, device: str = "") -> bool:
    """Count a real render failure blamed on the encoder, drop its cached
    passes, and switch it (or the VAAPI node) off at the limit. True when it
    is now off."""
    key = _state_key(encoder, device)
    with _state_lock:
        _failures[key] = _failures.get(key, 0) + 1
        if _failures[key] >= VIDEO_ENCODER_MAX_FAILURES:
            _off.add(key)
        off = key in _off
    drop_passes(encoder, key[1])
    where = f" on {device}" if key[1] else ""
    logger.warning("%s%s failed a render (%s)%s", encoder, where, reason, ", off" if off else "")
    return off


def _node_off(device: str) -> bool:
    with _state_lock:
        return (VAAPI, device) in _off


def disabled(platform: str | None = None) -> list[str]:
    """Encoders off for this session; VAAPI once no node is left to try."""
    with _state_lock:
        whole = {e for e, _d in _off if e != VAAPI}
        vaapi_off = {d for e, d in _off if e == VAAPI}
    if vaapi_off and not [n for n in render_nodes(platform) if n not in vaapi_off]:
        whole.add(VAAPI)
    return [e for e in VIDEO_GPU_ENCODERS if e in whole]


def reset_state() -> None:
    global _testing, _active_encodes
    with _state_lock:
        _failures.clear()
        _off.clear()
    with _gate:
        _testing = False
        _active_encodes = 0


def _probe_vaapi(
    width: int,
    height: int,
    fps: int,
    cancelled: Callable[[], bool],
    force: bool,
    platform: str | None,
) -> ProbeResult:
    result = ProbeResult(VAAPI, width, height, fps, ok=False, reason=REASON_NO_DEVICE)
    for node in render_nodes(platform):
        if _node_off(node):
            result = ProbeResult(
                VAAPI,
                width,
                height,
                fps,
                ok=False,
                reason=REASON_DISABLED,
                device=node,
            )
            continue
        result = probe(VAAPI, width, height, fps, device=node, force=force, cancelled=cancelled)
        if result.ok or result.reason == STOP_CANCELLED:
            break
    return result


def _probe_encoder(
    encoder: str,
    width: int,
    height: int,
    fps: int,
    cancelled: Callable[[], bool],
    force: bool,
    platform: str | None,
) -> ProbeResult:
    if encoder == VAAPI:
        return _probe_vaapi(width, height, fps, cancelled, force, platform)
    if encoder in disabled(platform):
        return ProbeResult(encoder, width, height, fps, ok=False, reason=REASON_DISABLED)
    return probe(encoder, width, height, fps, force=force, cancelled=cancelled)


def choose(
    width: int,
    height: int,
    fps: int,
    setting: str = POLICY_AUTO,
    cancelled: Callable[[], bool] = never,
    platform: str | None = None,
) -> Choice:
    """The encoder for a render of this geometry. Blocking: may probe."""
    value = policy(setting)
    if value == POLICY_CPU:
        return Choice(VIDEO_CPU_ENCODER, reason=REASON_POLICY)
    order = (value,) if value in VIDEO_GPU_ENCODERS else AUTO[os_key(platform)]
    reason = REASON_NONE
    for encoder in order:
        if cancelled():
            return Choice(VIDEO_CPU_ENCODER, reason=STOP_CANCELLED)
        result = _probe_encoder(encoder, width, height, fps, cancelled, False, platform)
        if result.ok:
            return Choice(encoder, result.variant, result.device)
        reason = result.reason
        if reason == STOP_CANCELLED:
            break
    return Choice(VIDEO_CPU_ENCODER, reason=reason)


def _gpu_attempt(
    job: EncodeJob,
    choice: Choice,
    cancelled: Callable[[], bool],
) -> tuple[str | None, str]:
    """(None, "") when the GPU render made a good file, else (code, stderr)."""
    try:
        cmd = job.build(choice.encoder, choice.variant, choice.device)
        job.run(cmd, render_timeout_sec(job.duration_sec), TIMEOUT_VIDEO_GPU_STALL)
        validate_output(job.dest, job.width, job.height, job.fps, job.duration_sec, cancelled)
    except EncodeError as exc:
        return exc.code, exc.stderr
    except OutputInvalid as exc:
        return invalid_code(exc, job.dest), ""
    return None, ""


def _try_gpu(job: EncodeJob, choice: Choice, cancelled: Callable[[], bool]) -> str | None:
    """Render on the chosen GPU encoder. None when its file is good, else why
    it was given up; the file never outlives a failure or a cancel."""
    code: str | None = STOP_CANCELLED
    stderr = ""
    try:
        code, stderr = _gpu_attempt(job, choice, cancelled)
    finally:
        if code is not None:
            job.dest.unlink(missing_ok=True)
    if code is None:
        return None
    if code in _CANCEL_CODES:
        raise EncodeError(STOP_CANCELLED)
    if blames_encoder(choice.encoder, code, stderr):
        record_failure(choice.encoder, code, choice.device)
    logger.warning("GPU render with %s failed (%s), rendering on the CPU", choice.encoder, code)
    return code


def encode(
    job: EncodeJob,
    setting: str = POLICY_AUTO,
    cancelled: Callable[[], bool] = never,
) -> EncodeOutcome:
    """Render `job` on the chosen encoder, redone on libx264 when a GPU attempt
    fails or its file fails the check. EncodeError from the CPU run (or any
    cancel) goes to the caller. Blocking."""
    with encoding(cancelled):
        return _encode(job, setting, cancelled)


def _encode(job: EncodeJob, setting: str, cancelled: Callable[[], bool]) -> EncodeOutcome:
    choice = choose(job.width, job.height, job.fps, setting, cancelled)
    if choice.reason == STOP_CANCELLED:
        raise EncodeError(STOP_CANCELLED)
    fallback = None
    if choice.encoder != VIDEO_CPU_ENCODER:
        fallback = _try_gpu(job, choice, cancelled)
        if fallback is None:
            family = FAMILY[choice.encoder]
            return EncodeOutcome(choice.encoder, family, choice.variant, choice.device)
    job.run(job.build(VIDEO_CPU_ENCODER, 0, ""), render_timeout_sec(job.duration_sec), None)
    return EncodeOutcome(VIDEO_CPU_ENCODER, FAMILY[VIDEO_CPU_ENCODER], fallback_reason=fallback)


def _test_one(
    encoder: str,
    geometry: tuple[int, int, int],
    deadline: float,
    platform: str | None,
) -> dict:
    width, height, fps = geometry
    if time.monotonic() >= deadline:
        return ProbeResult(encoder, width, height, fps, ok=False, reason=REASON_BUDGET).view()
    if encoder == VIDEO_CPU_ENCODER:
        return run_probe(encoder, width, height, fps).view()
    return _probe_encoder(encoder, width, height, fps, never, True, platform).view()


def test_all(
    budget_sec: float = VIDEO_ENCODER_TEST_BUDGET_SEC,
    platform: str | None = None,
) -> list[dict]:
    """Settings > Test encoders: probe every candidate of this OS afresh, and
    libx264 for comparison, at each test geometry within `budget_sec`. One row
    per encoder: {"encoder", "family", "disabled", "results": {name: view}}."""
    deadline = time.monotonic() + budget_sec
    off = disabled(platform)
    return [
        {
            "encoder": encoder,
            "family": FAMILY[encoder],
            "disabled": encoder in off,
            "results": {
                name: _test_one(encoder, geometry, deadline, platform)
                for name, geometry in TEST_GEOMETRIES.items()
            },
        }
        for encoder in (*CANDIDATES[os_key(platform)], VIDEO_CPU_ENCODER)
    ]
