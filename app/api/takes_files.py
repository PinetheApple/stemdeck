"""The blocking file work behind the takes routes, run in a thread under the
song's lock. Each step validates before it changes a file, and take.json is
written last, so a crash leaves a take that can be resumed or finished."""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from app.api.takes_camera_files import filmed_state, finish_camera, start_fields
from app.api.takes_models import CreateTakeBody, FinishBody
from app.core.song_folder import write_json_atomic
from app.core.takes import (
    is_finished,
    new_id,
    placement_sec,
    read_json,
    take_folders,
    takes_on_track,
)
from app.core.takes_config import (
    AUDIO_PART_FILE,
    EMPTY_PART_STATE,
    PARTS_FILE,
    RAW_WAV_FILE,
    SIDECAR_FILE,
    SIDECAR_VERSION,
    STEMS_DIRNAME,
    TAKE_ID_PREFIX,
    TAKE_LABEL_TEMPLATE,
    TAKE_PEAKS_FILE,
    TAKE_RATE,
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

AUDIO_STREAM = "audio"


def capture_of(state: dict[str, Any]) -> dict[str, Any]:
    """The capture block of an open take's start sidecar."""
    return state["start"]["capture"]


def frame_bytes(state: dict[str, Any]) -> int:
    return int(capture_of(state)["channels"]) * TAKE_SAMPLE_BYTES


def open_state(folder: Path) -> dict[str, Any]:
    """parts.json of a take that can still change, or 404 / 409. A take.json
    beside it means finished, whatever parts.json says: it is written first."""
    state = read_json(folder / PARTS_FILE)
    if not state:
        raise HTTPException(status_code=404, detail="take not found")
    if state.get("finished") or is_finished(folder):
        raise HTTPException(status_code=409, detail="take already finished")
    return state


def open_take(
    job_dir: Path,
    body: CreateTakeBody,
    take_max: int,
    track: dict[str, Any],
) -> tuple[str, str]:
    """Make the take's folder and parts.json, holding the start sidecar, so
    an orphaned take can still be finished. A video track's "I play" stems
    are copied in. Returns (take_id, label)."""
    root = job_dir / TAKES_DIRNAME
    root.mkdir(parents=True, exist_ok=True)
    existing = {p.name for p in take_folders(root)}
    if len(existing) >= take_max:
        raise HTTPException(status_code=409, detail="too many takes for this song")
    take_id = new_id(TAKE_ID_PREFIX, existing)
    label = body.label or TAKE_LABEL_TEMPLATE.format(n=len(takes_on_track(root, body.track_id)) + 1)
    now = time.time()
    (root / take_id).mkdir()
    state = {
        "label": label,
        "track_id": body.track_id,
        "created_at": now,
        "updated_at": now,
        "finished": False,
        AUDIO_STREAM: dict(EMPTY_PART_STATE),
        "start": body.model_dump(include=start_fields(body)),
        **filmed_state(body, track),
    }
    write_json_atomic(root / take_id / PARTS_FILE, state)
    return take_id, label


def append_part(folder: Path, seq: int, data: bytes, cap: int) -> dict[str, Any]:
    """Append audio part `seq` (whole sample frames)."""
    state = open_state(folder)
    if len(data) % frame_bytes(state):
        raise HTTPException(status_code=422, detail="part must hold whole sample frames")
    return append_stream(folder, state, AUDIO_STREAM, AUDIO_PART_FILE, seq, data, cap)


def append_stream(
    folder: Path,
    state: dict[str, Any],
    stream: str,
    part_file: str,
    seq: int,
    data: bytes,
    cap: int,
) -> dict[str, Any]:
    """Append part `seq` of `stream` to `part_file`. Repeating the last part
    is a no-op; any other seq than the next is a 409. Returns {"seq",
    "bytes", "duplicate"}."""
    next_seq, received = int(state[stream]["next_seq"]), int(state[stream]["bytes"])
    if next_seq > 0 and seq == next_seq - 1:
        return {"seq": seq, "bytes": received, "duplicate": True}
    if seq != next_seq:
        raise HTTPException(status_code=409, detail="unexpected part sequence")
    if received + len(data) > cap:
        raise HTTPException(status_code=413, detail="take too large for this song")
    with (folder / part_file).open("ab") as fh:
        # Cut back to what parts.json says arrived: a crash between the write
        # and the state update must not leave the retried part in twice.
        fh.truncate(received)
        fh.seek(received)
        fh.write(data)
    state[stream] = {"next_seq": seq + 1, "bytes": received + len(data)}
    state["updated_at"] = time.time()
    write_json_atomic(folder / PARTS_FILE, state)
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
    capture = {**capture_of(state)}
    if body.dropped_quanta is not None:
        capture["dropped_quanta"] = body.dropped_quanta
    timeline = {**start["timeline"]}
    if body.end_song_sec is not None:
        timeline["end_song_sec"] = body.end_song_sec
    return {
        **({"i_play": state["i_play"]} if "i_play" in state else {}),
        "v": SIDECAR_VERSION,
        "id": folder.name,
        "track_id": state["track_id"],
        "label": body.label or state.get("label") or folder.name,
        "created_at": float(state.get("created_at") or time.time()),
        "timeline": timeline,
        "latency": {**start["latency"]},
        "capture": capture,
    }


def song_seconds(job_dir: Path) -> float | None:
    """The song's length from its stems, or None without one."""
    frames = song_frames(job_dir / STEMS_DIRNAME)
    return None if frames is None else frames / TAKE_RATE


def render_lane(job_dir: Path, folder: Path, sidecar: dict[str, Any]) -> None:
    """(Re)render audio.wav and peaks.json from audio.raw.wav at the
    sidecar's placement, and record the raw take's length."""
    frames = song_frames(job_dir / STEMS_DIRNAME)
    if frames is None:
        raise HTTPException(status_code=404, detail="stems not found")
    raw = folder / RAW_WAV_FILE
    rate = int(sidecar["capture"]["rate"])
    sidecar["placement_sec"] = placement_sec(sidecar)
    sidecar["duration_sec"] = wav_frames(raw) / rate
    wav = folder / TAKE_WAV_FILE
    try:
        render_take_audio(
            raw,
            wav,
            sidecar["placement_sec"],
            frames,
            rate,
            int(sidecar["capture"]["channels"]),
        )
    except TakeRenderError:
        raise HTTPException(status_code=500, detail="take render failed") from None
    write_take_peaks(wav, folder / TAKE_PEAKS_FILE, folder.name)


def finish_take_files(job_dir: Path, folder: Path, body: FinishBody) -> dict[str, Any]:
    """Close an open take: raw WAV, playable lane, peaks, then take.json, then
    parts.json. Returns the sidecar."""
    state = open_state(folder)
    _check_audio(folder, state)
    sidecar = {**_build_sidecar(folder, state, body), **finish_camera(folder, state, body.camera)}
    part = folder / AUDIO_PART_FILE
    if part.is_file() and part.stat().st_size > 0:
        capture = capture_of(state)
        assemble_raw_wav(part, folder / RAW_WAV_FILE, capture["rate"], capture["channels"])
        part.unlink()
    render_lane(job_dir, folder, sidecar)
    write_json_atomic(folder / SIDECAR_FILE, sidecar)
    write_json_atomic(folder / PARTS_FILE, {**state, "finished": True, "updated_at": time.time()})
    return sidecar


def remove_take(folder: Path) -> None:
    try:
        shutil.rmtree(folder)
    except FileNotFoundError:
        return
    except OSError:
        raise HTTPException(status_code=500, detail="take files could not be deleted") from None
