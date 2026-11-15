"""The blocking file work behind the takes routes, run in a thread under the
song's lock (app/api/takes_common.job_lock). Each step validates before it
changes a file, so a refused request can be corrected and sent again, and
writes atomically, so a crash at any point leaves a take that can be resumed
or finished (docs/takes.md).
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.api.takes_models import CreateTakeBody, FinishBody
from app.core.takes import new_id, placement_sec, read_json, write_json_atomic
from app.core.takes_config import (
    AUDIO_PART_FILE,
    PARTS_FILE,
    RAW_WAV_FILE,
    SIDECAR_FILE,
    SIDECAR_VERSION,
    TAKE_ID_PREFIX,
    TAKE_ID_RE,
    TAKE_PEAKS_FILE,
    TAKE_SAMPLE_BYTES,
    TAKE_WAV_FILE,
    TAKES_DIRNAME,
)
from app.pipeline.take_render import (
    TakeRenderError,
    assemble_raw_wav,
    render_take_audio,
    song_frames,
    wav_frames,
    write_take_peaks,
)


def frame_bytes(state: dict[str, Any]) -> int:
    channels = int(((state.get("start") or {}).get("capture") or {}).get("channels") or 1)
    return channels * TAKE_SAMPLE_BYTES


def open_take(job_dir: Path, body: CreateTakeBody, take_max: int) -> tuple[str, str]:
    """Make the take's folder and parts.json, holding the start sidecar, so
    an orphaned take can still be finished. Returns (take_id, label)."""
    root = job_dir / TAKES_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    existing = {p.name for p in root.iterdir() if TAKE_ID_RE.match(p.name)}
    if len(existing) >= take_max:
        raise HTTPException(status_code=409, detail="too many takes for this song")
    on_track = sum(
        1
        for name in existing
        if read_json(root / name / PARTS_FILE).get("track_id") == body.track_id
    )
    take_id = new_id(TAKE_ID_PREFIX, existing)
    label = body.label or f"Take {on_track + 1}"
    now = time.time()
    (root / take_id).mkdir()
    state = {
        "label": label,
        "track_id": body.track_id,
        "created_at": now,
        "updated_at": now,
        "finished": False,
        "audio": {"next_seq": 0, "bytes": 0},
        "start": body.model_dump(include={"timeline", "latency", "capture"}),
    }
    write_json_atomic(root / take_id / PARTS_FILE, state)
    return take_id, label


def append_part(folder: Path, seq: int, data: bytes, cap: int) -> dict[str, Any]:
    """Append part `seq`. Repeating the last part is a no-op; any other seq
    than the next is a 409. Returns {"seq", "bytes", "duplicate"}."""
    state_path = folder / PARTS_FILE
    state = read_json(state_path)
    if not state:
        raise HTTPException(status_code=404, detail="take not found")
    if state.get("finished"):
        raise HTTPException(status_code=409, detail="take already finished")
    if len(data) % frame_bytes(state):
        raise HTTPException(status_code=422, detail="part must hold whole sample frames")
    slot = state["audio"]
    next_seq, received = int(slot["next_seq"]), int(slot["bytes"])
    if next_seq > 0 and seq == next_seq - 1:
        return {"seq": seq, "bytes": received, "duplicate": True}
    if seq != next_seq:
        raise HTTPException(status_code=409, detail="unexpected part sequence")
    if received + len(data) > cap:
        raise HTTPException(status_code=413, detail="take too large for this song")
    with (folder / AUDIO_PART_FILE).open("ab") as fh:
        # Cut back to what parts.json says arrived: a crash between the write
        # and the state update must not leave the retried part in twice.
        fh.truncate(received)
        fh.seek(received)
        fh.write(data)
    state["audio"] = {"next_seq": seq + 1, "bytes": received + len(data)}
    state["updated_at"] = time.time()
    write_json_atomic(state_path, state)
    return {"seq": seq, "bytes": received + len(data), "duplicate": False}


def _check_audio(folder: Path, state: dict[str, Any]) -> None:
    part = folder / AUDIO_PART_FILE
    if part.is_file() and part.stat().st_size > 0:
        if part.stat().st_size % frame_bytes(state):
            raise HTTPException(status_code=422, detail="audio does not match the channel count")
    elif not (folder / RAW_WAV_FILE).is_file():
        raise HTTPException(status_code=422, detail="take has no audio")


def _build_sidecar(folder: Path, state: dict[str, Any], body: FinishBody) -> dict[str, Any]:
    start = state["start"]
    capture = {**start["capture"]}
    if body.dropped_quanta is not None:
        capture["dropped_quanta"] = body.dropped_quanta
    timeline = {**start["timeline"]}
    if body.end_song_sec is not None:
        timeline["end_song_sec"] = body.end_song_sec
    sidecar: dict[str, Any] = {
        "v": SIDECAR_VERSION,
        "id": folder.name,
        "track_id": state["track_id"],
        "label": body.label or state.get("label") or folder.name,
        "created_at": float(state.get("created_at") or time.time()),
        "timeline": timeline,
        "latency": {**start["latency"]},
        "capture": capture,
    }
    sidecar["placement_sec"] = placement_sec(sidecar)
    return sidecar


def render_lane(job_dir: Path, folder: Path, sidecar: dict[str, Any]) -> None:
    """(Re)render audio.wav and peaks.json from audio.raw.wav at the
    sidecar's placement, and record the raw take's length."""
    frames = song_frames(job_dir / "stems")
    if frames is None:
        raise HTTPException(status_code=404, detail="stems not found")
    raw = folder / RAW_WAV_FILE
    capture = sidecar["capture"]
    sidecar["placement_sec"] = placement_sec(sidecar)
    sidecar["duration_sec"] = wav_frames(raw) / int(capture["rate"])
    wav = folder / TAKE_WAV_FILE
    try:
        render_take_audio(
            raw,
            wav,
            sidecar["placement_sec"],
            frames,
            int(capture["rate"]),
            int(capture["channels"]),
        )
    except TakeRenderError:
        raise HTTPException(status_code=500, detail="take render failed") from None
    write_take_peaks(wav, folder / TAKE_PEAKS_FILE, folder.name)


def finish_take_files(job_dir: Path, folder: Path, body: FinishBody) -> dict[str, Any]:
    """Close an open take: raw WAV, playable lane, peaks, then take.json.
    take.json goes last, so a crash before it leaves an open take that a
    second finish completes from audio.raw.wav. Returns the sidecar."""
    state_path = folder / PARTS_FILE
    state = read_json(state_path)
    if not state:
        raise HTTPException(status_code=404, detail="take not found")
    if state.get("finished"):
        raise HTTPException(status_code=409, detail="take already finished")
    _check_audio(folder, state)
    sidecar = _build_sidecar(folder, state, body)
    part = folder / AUDIO_PART_FILE
    if part.is_file() and part.stat().st_size > 0:
        capture = sidecar["capture"]
        assemble_raw_wav(part, folder / RAW_WAV_FILE, capture["rate"], capture["channels"])
        part.unlink()
    render_lane(job_dir, folder, sidecar)
    write_json_atomic(folder / SIDECAR_FILE, sidecar)
    write_json_atomic(state_path, {**state, "finished": True, "updated_at": time.time()})
    return sidecar


def remove_take(folder: Path) -> None:
    try:
        shutil.rmtree(folder)
    except FileNotFoundError:
        return
    except OSError:
        raise HTTPException(status_code=500, detail="take files could not be deleted") from None
