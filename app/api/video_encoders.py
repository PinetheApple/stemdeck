"""The video export's H.264 encoders, for Settings > Export.

GET reports which encoder policy is in force (the setting, or the
STEMDECK_VIDEO_ENCODER override), this OS's candidates, the encoders switched
off this session and the cached test results. POST /test runs a fresh test
encode of every candidate and libx264: one at a time, and never while a
render is encoding, since both would compete for the same device.
"""

from __future__ import annotations

import asyncio
import threading

from fastapi import APIRouter, HTTPException

from app.core.settings import get_video_encoder
from app.pipeline.video_encoder import disabled, encode_running, encoder_override, policy, test_all
from app.pipeline.video_encoder_args import CANDIDATES, os_key
from app.pipeline.video_probe_store import cached_results

router = APIRouter()

_test_lock = threading.Lock()
_BUSY_DETAIL = "an encoder test or a video export is running"


@router.get("")
def get_video_encoders() -> dict[str, object]:
    setting = get_video_encoder()
    return {
        "policy": policy(setting),
        "setting": setting,
        "env": encoder_override(),
        "candidates": list(CANDIDATES[os_key()]),
        "disabled": disabled(),
        "results": [result.view() for result in cached_results()],
    }


@router.post("/test")
async def test_video_encoders() -> dict[str, object]:
    if encode_running() or not _test_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail=_BUSY_DETAIL)
    try:
        rows = await asyncio.to_thread(test_all)
    finally:
        _test_lock.release()
    return {"rows": rows}
