"""Request bodies of filmed takes: the camera a take opens and finishes with,
the export trim, the "I play" stems and the MP4 render. Unknown fields are
refused."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from app.core.take_video_config import (
    CAMERA_DIM_MAX,
    CAMERA_FPS_MAX,
    CAMERA_MIME_MAX,
    CAMERA_MIMES,
    CAMERA_OFFSET_MAX_MS,
    FIRST_FRAME_CLOCKS,
    FIRST_FRAME_OFFSET_MAX_MS,
    I_PLAY_STEMS,
    RENDER_FPS,
    RENDER_FPS_DEFAULT,
    RENDER_SIZE_DEFAULT,
    RENDER_SIZES,
    TAKE_GAIN_MAX,
    TRACK_KINDS,
)
from app.core.takes_config import TAKE_MAX_SEQ, TRACK_INPUT_LABEL_MAX


def _known_stems(value: list[str]) -> list[str]:
    unknown = [s for s in value if s not in I_PLAY_STEMS]
    if unknown:
        raise ValueError(f"unknown stem: {', '.join(unknown)}")
    return list(dict.fromkeys(value))


IPlay = Annotated[list[str], Field(max_length=len(I_PLAY_STEMS) * 2), AfterValidator(_known_stems)]
TrackKind = Literal[TRACK_KINDS]
RenderSize = Literal[tuple(RENDER_SIZES)]
RenderFps = Literal[RENDER_FPS]
OffsetMs = Annotated[
    float,
    Field(ge=-CAMERA_OFFSET_MAX_MS, le=CAMERA_OFFSET_MAX_MS, allow_inf_nan=False),
]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CameraStartModel(_Strict):
    """What the recorder films with, sent when the take opens."""

    mime: str = Field(max_length=CAMERA_MIME_MAX)
    width: int = Field(ge=1, le=CAMERA_DIM_MAX)
    height: int = Field(ge=1, le=CAMERA_DIM_MAX)
    fps_nominal: float = Field(gt=0, le=CAMERA_FPS_MAX, allow_inf_nan=False)
    device_label: str | None = Field(default=None, max_length=TRACK_INPUT_LABEL_MAX)
    mirror: bool = False
    offset_ms: OffsetMs = 0.0

    @field_validator("mime")
    @classmethod
    def _video_mime(cls, v: str) -> str:
        if v.split(";", 1)[0].strip().lower() not in CAMERA_MIMES:
            raise ValueError(f"must be one of {', '.join(CAMERA_MIMES)}")
        return v


class CameraFinishModel(_Strict):
    """When the camera's first frame was taken, against the first audio frame."""

    first_frame_offset_ms: float = Field(
        ge=-FIRST_FRAME_OFFSET_MAX_MS,
        le=FIRST_FRAME_OFFSET_MAX_MS,
        allow_inf_nan=False,
    )
    first_frame_clock: Literal[FIRST_FRAME_CLOCKS]
    parts: int = Field(ge=0, le=TAKE_MAX_SEQ + 1)


class TrimModel(_Strict):
    in_sec: float = Field(ge=0, allow_inf_nan=False)
    out_sec: float = Field(ge=0, allow_inf_nan=False)


class RenderBody(_Strict):
    """The backing mix as the export dialog has it, plus the picture's format."""

    stems: list[str] = Field(default_factory=list)
    gains: list[float] = Field(default_factory=list)
    pitches: list[int] | None = None
    take_gain: float = Field(default=1.0, ge=0, le=TAKE_GAIN_MAX, allow_inf_nan=False)
    i_play: IPlay | None = None
    size: RenderSize = RENDER_SIZE_DEFAULT
    fps: RenderFps = RENDER_FPS_DEFAULT
    mirror: bool | None = None
