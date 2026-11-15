"""Which H.264 encoder makes a filmed-take export, and the CPU fallback.

libx264 is the default and the answer to every doubt. A GPU encoder is used
only when all of this holds:

1. The policy allows it: the `video_encoder` setting ("auto", "cpu" or one
   encoder), overridden by STEMDECK_VIDEO_ENCODER ("cpu" is the kill switch).
2. The setting picks it, or Auto tries it on this OS (video_encoder_args.AUTO:
   NVENC on Windows only until another encoder runs on real hardware), and it
   has not failed VIDEO_ENCODER_MAX_FAILURES renders since this process began.
   VAAPI counts per render node and is off only once every node is.
3. A real test encode at the render's own geometry passed (video_probe).
4. After the render, its file passes validate_output. Anything else: the file
   is deleted and the render runs again on libx264 (encode()).

QSV, AMF and VideoToolbox, and every Windows path, have only run against
mocks: treat them as unverified until someone runs Settings > Test encoders.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from app.core.video_config import (
    LOGGER_NAME,
    POLICY_AUTO,
    POLICY_CPU,
    TEST_GEOMETRIES,
    TIMEOUT_VIDEO_GPU_STALL,
    VAAPI,
    VIDEO_CPU_ENCODER,
    VIDEO_ENCODER_CHOICES,
    VIDEO_ENCODER_MAX_FAILURES,
    VIDEO_ENCODER_TEST_BUDGET_SEC,
    VIDEO_GPU_ENCODERS,
    encoder_override,
    render_timeout_sec,
)
from app.pipeline.video_encoder_args import AUTO, CANDIDATES, FAMILY, os_key, render_nodes
from app.pipeline.video_probe import (
    INVALID_PREFIX,
    REASON_NO_DEVICE,
    ProbeResult,
    blames_encoder,
    drop_passes,
    probe,
    run_probe,
)
from app.pipeline.video_validate import STOP_CANCELLED, OutputInvalid, never, validate_output

logger = logging.getLogger(LOGGER_NAME)

SOURCE_ENV = "env"
SOURCE_SETTING = "setting"
REASON_POLICY = "policy"
REASON_NONE = "none"
REASON_DISABLED = "disabled"
REASON_BUDGET = "budget"

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


def policy(setting: str = POLICY_AUTO) -> tuple[str, str]:
    """(value, source): the env override when set, else the setting."""
    override = encoder_override()
    if override is not None:
        return override, SOURCE_ENV
    return (setting if setting in VIDEO_ENCODER_CHOICES else POLICY_AUTO), SOURCE_SETTING


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
    logger.warning(
        "%s%s failed a render (%s)%s",
        encoder,
        f" on {device}" if key[1] else "",
        reason,
        ", off until restart" if off else "",
    )
    return off


def failure_count(encoder: str, device: str = "") -> int:
    with _state_lock:
        return _failures.get(_state_key(encoder, device), 0)


def _node_off(device: str) -> bool:
    with _state_lock:
        return (VAAPI, device) in _off


def disabled(platform: str | None = None) -> list[str]:
    """Encoders off for this session; VAAPI once every node with a failure
    count is off and no other node is left to try."""
    with _state_lock:
        whole = {e for e, d in _off if e != VAAPI}
        vaapi_off = {d for e, d in _off if e == VAAPI}
    if vaapi_off and not [n for n in render_nodes(platform) if n not in vaapi_off]:
        whole.add(VAAPI)
    return [e for e in VIDEO_GPU_ENCODERS if e in whole]


def reset_state() -> None:
    with _state_lock:
        _failures.clear()
        _off.clear()


def _probe_encoder(
    encoder: str,
    width: int,
    height: int,
    fps: int,
    cancelled: Callable[[], bool],
    force: bool,
    platform: str | None,
) -> ProbeResult:
    if encoder != VAAPI:
        if encoder in disabled(platform):
            return ProbeResult(encoder, width, height, fps, ok=False, reason=REASON_DISABLED)
        return probe(encoder, width, height, fps, force=force, cancelled=cancelled)
    result = ProbeResult(encoder, width, height, fps, ok=False, reason=REASON_NO_DEVICE)
    for node in render_nodes(platform):
        if _node_off(node):
            result = ProbeResult(
                encoder,
                width,
                height,
                fps,
                ok=False,
                reason=REASON_DISABLED,
                device=node,
            )
            continue
        result = probe(encoder, width, height, fps, device=node, force=force, cancelled=cancelled)
        if result.ok or result.reason == STOP_CANCELLED:
            break
    return result


def choose(
    width: int,
    height: int,
    fps: int,
    setting: str = POLICY_AUTO,
    cancelled: Callable[[], bool] = never,
    platform: str | None = None,
) -> Choice:
    """The encoder for a render of this geometry. Blocking: may probe."""
    value, _source = policy(setting)
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


def _try_gpu(job: EncodeJob, choice: Choice, cancelled: Callable[[], bool]) -> str | None:
    """Render on the chosen GPU encoder and check the file. None when it is
    good, else why it was given up (the file is deleted)."""
    try:
        cmd = job.build(choice.encoder, choice.variant, choice.device)
        job.run(cmd, render_timeout_sec(job.duration_sec), TIMEOUT_VIDEO_GPU_STALL)
        validate_output(job.dest, job.width, job.height, job.fps, job.duration_sec, cancelled)
        return None
    except EncodeError as exc:
        code, stderr = exc.code, exc.stderr
    except OutputInvalid as exc:
        code, stderr = INVALID_PREFIX + exc.code, ""
    if code in (STOP_CANCELLED, INVALID_PREFIX + STOP_CANCELLED):
        raise EncodeError(STOP_CANCELLED)
    job.dest.unlink(missing_ok=True)
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
    choice = choose(job.width, job.height, job.fps, setting, cancelled)
    if choice.reason == STOP_CANCELLED:
        raise EncodeError(STOP_CANCELLED)
    fallback = None
    if choice.encoder != VIDEO_CPU_ENCODER:
        fallback = _try_gpu(job, choice, cancelled)
        if fallback is None:
            return EncodeOutcome(
                choice.encoder,
                FAMILY[choice.encoder],
                choice.variant,
                choice.device,
            )
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
                name: _test_one(encoder, geo, deadline, platform)
                for name, geo in TEST_GEOMETRIES.items()
            },
        }
        for encoder in (*CANDIDATES[os_key(platform)], VIDEO_CPU_ENCODER)
    ]
