"""Request bodies of the takes and tracks routes (docs/takes.md).

Unknown fields are refused, so a client that drifts from the contract hears
about it instead of having a field silently dropped. Labels lose control
characters and surrounding space, and are cut to TAKE_LABEL_MAX.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from app.core.takes_config import (
    CAPTURE_RATE_MAX,
    CAPTURE_RATE_MIN,
    LATENCY_SOURCES,
    TAKE_COUNT_IN_MAX_SEC,
    TAKE_FRAME0_MAX_SEC,
    TAKE_FRAME0_MIN_SEC,
    TAKE_LABEL_MAX,
    TAKE_NUDGE_MAX_MS,
    TAKE_ROUND_TRIP_MAX_MS,
    TAKE_TEMPO,
    TRACK_INPUT_CHANNEL_MAX,
    TRACK_INPUT_ID_MAX,
    TRACK_INPUT_LABEL_MAX,
    TRACK_KINDS,
)

_CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")
# Room for a label that only fits after its control characters are removed.
_RAW_LABEL_MAX = TAKE_LABEL_MAX * 4
_STEREO = 2


def clean_label(value: str | None) -> str | None:
    if value is None:
        return None
    return _CONTROL_CHARS.sub("", value).strip()[:TAKE_LABEL_MAX] or None


def _one_of(choices: tuple[str, ...]):
    def check(value: str) -> str:
        if value not in choices:
            raise ValueError(f"must be one of {', '.join(choices)}")
        return value

    return AfterValidator(check)


Label = Annotated[
    str | None,
    Field(default=None, max_length=_RAW_LABEL_MAX),
    AfterValidator(clean_label),
]
LatencySource = Annotated[str, _one_of(LATENCY_SOURCES)]
TrackKind = Annotated[str, _one_of(TRACK_KINDS)]


def _finite(lo: float, hi: float, default: float | None = None):
    return Field(default=default, ge=lo, le=hi, allow_inf_nan=False)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TimelineModel(_Strict):
    frame0_song_sec: float = Field(
        ge=TAKE_FRAME0_MIN_SEC, le=TAKE_FRAME0_MAX_SEC, allow_inf_nan=False
    )
    tempo: float = TAKE_TEMPO
    count_in_sec: float | None = _finite(0, TAKE_COUNT_IN_MAX_SEC)

    @field_validator("tempo")
    @classmethod
    def _normal_speed(cls, v: float) -> float:
        if v != TAKE_TEMPO:
            raise ValueError("takes are recorded at normal speed only")
        return v


class LatencyModel(_Strict):
    round_trip_ms: float = _finite(0, TAKE_ROUND_TRIP_MAX_MS)
    source: LatencySource
    output_latency_ms: float | None = _finite(0, TAKE_ROUND_TRIP_MAX_MS)
    base_latency_ms: float | None = _finite(0, TAKE_ROUND_TRIP_MAX_MS)
    user_nudge_ms: float = _finite(-TAKE_NUDGE_MAX_MS, TAKE_NUDGE_MAX_MS, 0.0)


class CaptureModel(_Strict):
    rate: int = Field(ge=CAPTURE_RATE_MIN, le=CAPTURE_RATE_MAX)
    channels: Literal[1, 2]
    device_label: str | None = Field(default=None, max_length=TRACK_INPUT_LABEL_MAX)


class CreateTakeBody(_Strict):
    track_id: str = Field(max_length=16)
    label: Label = None
    timeline: TimelineModel
    latency: LatencyModel
    capture: CaptureModel


class FinishBody(_Strict):
    label: Label = None
    end_song_sec: float | None = _finite(TAKE_FRAME0_MIN_SEC, TAKE_FRAME0_MAX_SEC)
    dropped_quanta: int | None = Field(default=None, ge=0)


class PatchTakeBody(_Strict):
    label: Label = None
    round_trip_ms: float | None = _finite(0, TAKE_ROUND_TRIP_MAX_MS)
    user_nudge_ms: float | None = _finite(-TAKE_NUDGE_MAX_MS, TAKE_NUDGE_MAX_MS)


class TrackInput(_Strict):
    """Which input a track records from. Stored for the UI only: capture runs
    in the browser, and the take's sidecar says what was really captured."""

    device_id: str | None = Field(default=None, max_length=TRACK_INPUT_ID_MAX)
    device_label: str | None = Field(default=None, max_length=TRACK_INPUT_LABEL_MAX)
    channels: list[int] = Field(min_length=1, max_length=_STEREO)

    @field_validator("channels")
    @classmethod
    def _channels(cls, v: list[int]) -> list[int]:
        if any(not 0 <= c <= TRACK_INPUT_CHANNEL_MAX for c in v):
            raise ValueError("channel index out of range")
        if len(set(v)) != len(v):
            raise ValueError("a stereo pair needs two different channels")
        return v


class CreateTrackBody(_Strict):
    name: Label = None
    kind: TrackKind | None = None
    input: TrackInput | None = None


class PatchTrackBody(CreateTrackBody):
    active_take_id: str | None = Field(default=None, max_length=16)
    order: int | None = Field(default=None, ge=0)
