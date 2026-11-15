"""Shared bits of the filmed-take tests (#102): a synthetic camera clip that
is black except one white frame, its MediaRecorder-style upload, and a
finished filmed take made through the routes."""

from __future__ import annotations

import subprocess
from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import ffmpeg_executable, ffprobe_executable
from tests._takes_helpers import JOB, OCTET, new_take, new_track, pcm, put_part

CAM_W = 320
CAM_H = 240
CAM_FPS = 30
CAM_SEC = 4.0
FLASH_FRAME = 45
# Two frames, so a 24 fps export, which drops one camera frame in five, keeps one.
FLASH_FRAMES = 2
FLASH_SEC = FLASH_FRAME / CAM_FPS
BLACK_Y = 16
WHITE_Y = 235
FLASH_YAVG = 100
_TIMEOUT = 120
CAMERA_START = {"mime": "video/webm;codecs=vp8", "width": CAM_W, "height": CAM_H, "fps_nominal": 30}
CAMERA_CODECS = {".webm": ["-c:v", "libvpx", "-b:v", "1M"], ".mp4": ["-c:v", "libx264"]}


def make_camera(dest: Path, first_pts_sec: float = 0.0, seconds: float = CAM_SEC) -> Path:
    """A black clip at CAM_FPS, white from FLASH_FRAME for FLASH_FRAMES frames; webm
    (VP8) or mp4 (H.264) by suffix, its first timestamp at `first_pts_sec`."""
    last = FLASH_FRAME + FLASH_FRAMES - 1
    flash = f"geq=lum='if(between(N,{FLASH_FRAME},{last}),{WHITE_Y},{BLACK_Y})':cb=128:cr=128"
    source = f"color=black:s={CAM_W}x{CAM_H}:r={CAM_FPS}:d={seconds},format=yuv420p,{flash}"
    cmd = [ffmpeg_executable(), "-nostdin", "-v", "error", "-y", "-f", "lavfi", "-i", source]
    cmd += [*CAMERA_CODECS[dest.suffix], "-pix_fmt", "yuv420p"]
    cmd += ["-output_ts_offset", f"{first_pts_sec}", str(dest)]
    subprocess.run(cmd, check=True, timeout=_TIMEOUT)
    return dest


def flash_time(path: Path) -> float | None:
    """The first frame of `path` brighter than FLASH_YAVG, in seconds."""
    cmd = [ffprobe_executable(), "-v", "error", "-f", "lavfi", f"movie={path},signalstats"]
    cmd += ["-show_entries", "frame=pts_time:frame_tags=lavfi.signalstats.YAVG"]
    cmd += ["-of", "csv=p=0"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=_TIMEOUT)
    for line in out.stdout.splitlines():
        fields = [f for f in line.split(",") if f]
        if len(fields) >= 2 and float(fields[1]) > FLASH_YAVG:
            return float(fields[0])
    return None


def video_track(client: TestClient, i_play: list[str] | None = None) -> str:
    return new_track(client, kind="video", i_play=i_play or [])


def upload_camera(client: TestClient, take_id: str, data: bytes, chunks: int = 3) -> int:
    """Send `data` as `chunks` camera parts; returns how many were sent."""
    size = -(-len(data) // chunks)
    pieces = [data[i : i + size] for i in range(0, len(data), size)]
    for seq, piece in enumerate(pieces):
        r = client.put(
            f"/api/jobs/{JOB}/takes/{take_id}/camera/parts?seq={seq}",
            content=piece,
            headers=OCTET,
        )
        assert r.status_code == 200, r.text
    return len(pieces)


def filmed_take(
    client: TestClient,
    track_id: str,
    camera: Path,
    first_frame_offset_ms: float = 0.0,
    audio: bytes | None = None,
    **over,
) -> dict:
    """A take opened with a camera, given its audio and camera, finished."""
    take_id = new_take(client, track_id, camera=CAMERA_START, **over)
    assert put_part(client, take_id, 0, audio if audio is not None else pcm()).status_code == 200
    parts = upload_camera(client, take_id, camera.read_bytes())
    timing = {"first_frame_offset_ms": first_frame_offset_ms, "first_frame_clock": "capture"}
    r = client.post(
        f"/api/jobs/{JOB}/takes/{take_id}/finish",
        json={"camera": {**timing, "parts": parts}},
    )
    assert r.status_code == 200, r.text
    return r.json()
