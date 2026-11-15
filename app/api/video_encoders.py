"""The video export's H.264 encoders, for Settings > Export.

GET reports the encoder policy in force and where it comes from (the setting
or the STEMDECK_VIDEO_ENCODER override), this OS's choices and candidates, the
encoders switched off this session, whether filmed takes can be exported yet,
and the last Test encoders run. POST /test runs a fresh test encode of every
candidate and libx264: one at a time, and never while an export is encoding,
since both would compete for the same device.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, HTTPException

from app.core.settings import get_video_encoder
from app.core.video_config import CANDIDATES, encoder_choices, os_key
from app.pipeline.video_encoder import disabled as disabled_encoders
from app.pipeline.video_encoder import encoder_override, end_test, policy, test_all, try_begin_test

router = APIRouter()

# True once the filmed-take render routes are mounted.
RENDER_AVAILABLE = False
SOURCE_ENV = "env"
SOURCE_SETTING = "setting"
_BUSY_DETAIL = "an encoder test or a video export is running"

_last_test: dict[str, Any] | None = None


@router.get("")
def get_video_encoders() -> dict[str, object]:
    return {
        "policy": {
            "value": policy(get_video_encoder()),
            "source": SOURCE_ENV if encoder_override() is not None else SOURCE_SETTING,
        },
        "choices": list(encoder_choices()),
        "candidates": list(CANDIDATES[os_key()]),
        "disabled": disabled_encoders(),
        "render_available": RENDER_AVAILABLE,
        "last_test": _last_test,
    }


@router.post("/test")
async def test_video_encoders() -> dict[str, Any]:
    global _last_test
    if not try_begin_test():
        raise HTTPException(status_code=409, detail=_BUSY_DETAIL)
    try:
        rows = await asyncio.to_thread(test_all)
    finally:
        end_test()
    _last_test = {"rows": rows, "at": time.time()}
    return _last_test
