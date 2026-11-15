"""ffmpeg work for recorded takes: the raw capture becomes a playable lane in
the stems' format, starting at song 0 and exactly the song's length, so no
engine or export applies an offset of its own. Blocking: run in a thread."""

from __future__ import annotations

import logging
import os
import shutil
import struct
import subprocess
import uuid
from pathlib import Path

import soundfile as sf

from app.core.config import (
    EXTRA_STEM_NAMES,
    STEM_NAMES,
    TIMEOUT_FFMPEG,
    ffmpeg_executable,
    ffprobe_executable,
)
from app.core.song_folder import write_json_atomic
from app.core.stem_files import WAV_EXT, stem_path
from app.core.takes_config import (
    FFMPEG_STDERR_TAIL_BYTES,
    LOGGER_NAME,
    TAKE_CHANNELS,
    TAKE_PEAK_POINTS,
    TAKE_RATE,
    TAKE_SAMPLE_BYTES,
)
from app.pipeline.audio_stats import scan_stem

logger = logging.getLogger(LOGGER_NAME)

_WAVE_FORMAT_IEEE_FLOAT = 3
_BITS_PER_BYTE = 8
_FMT_CHUNK_BYTES = 16
_RIFF_HEADER_REST = 36
_COPY_CHUNK = 1024 * 1024
# Any stem: one Demucs pass writes them all, so they share a frame count.
_REFERENCE_NAMES = (*STEM_NAMES, *EXTRA_STEM_NAMES, "original")


class TakeRenderError(RuntimeError):
    """ffmpeg failed. The message is for the log, never for the client."""


def write_float_wav_header(fh, data_bytes: int, rate: int, channels: int) -> None:
    """A WAVE_FORMAT_IEEE_FLOAT header for 32-bit interleaved samples. The
    stdlib wave module writes integer PCM only, and the raw capture is kept
    bit-exact so a later re-render starts from what the microphone gave."""
    block_align = channels * TAKE_SAMPLE_BYTES
    fh.write(b"RIFF")
    fh.write(struct.pack("<I", _RIFF_HEADER_REST + data_bytes))
    fh.write(b"WAVEfmt ")
    fh.write(
        struct.pack(
            "<IHHIIHH",
            _FMT_CHUNK_BYTES,
            _WAVE_FORMAT_IEEE_FLOAT,
            channels,
            rate,
            rate * block_align,
            block_align,
            TAKE_SAMPLE_BYTES * _BITS_PER_BYTE,
        )
    )
    fh.write(b"data")
    fh.write(struct.pack("<I", data_bytes))


def assemble_raw_wav(pcm: Path, dest: Path, rate: int, channels: int) -> None:
    """Wrap the uploaded float32 parts in a WAV header, atomically."""
    size = pcm.stat().st_size
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp")
    try:
        with tmp.open("wb") as out, pcm.open("rb") as src:
            write_float_wav_header(out, size, rate, channels)
            shutil.copyfileobj(src, out, _COPY_CHUNK)
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


def wav_frames(path: Path) -> int:
    return int(sf.info(str(path)).frames)


def _probe_frames(path: Path) -> int | None:
    cmd = [
        ffprobe_executable(),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        out = subprocess.run(  # noqa: S603 -- list args, no shell, trusted ffprobe
            cmd,
            capture_output=True,
            timeout=TIMEOUT_FFMPEG,
            check=True,
            text=True,
        ).stdout
        return round(float(out.strip()) * TAKE_RATE)
    except (OSError, subprocess.SubprocessError, ValueError):
        logger.warning("could not read the length of %s", path.name, exc_info=True)
        return None


def song_frames(stems_dir: Path) -> int | None:
    """The song's length in 44.1 kHz frames, from its first stem: the WAV's
    own count, or an MP3-stored song's duration. None without a stem."""
    for name in _REFERENCE_NAMES:
        path = stem_path(stems_dir, name)
        if not path.is_file():
            continue
        if path.suffix.lower() == WAV_EXT:
            return wav_frames(path)
        return _probe_frames(path)
    return None


def take_audio_filter(placement_sec: float, frames: int, source_channels: int) -> str:
    """The -af chain from a raw take to a playable one: resampled first, then
    placed in output samples, trimmed when it starts before song 0 (count-in,
    pickup notes) or delayed when after, then padded and cut to `frames`."""
    parts: list[str] = []
    if source_channels == 1:
        parts.append("pan=stereo|c0=c0|c1=c0")
    parts.append(f"aresample={TAKE_RATE}")
    offset = round(placement_sec * TAKE_RATE)
    if offset < 0:
        parts.append(f"atrim=start_sample={-offset}")
        parts.append("asetpts=PTS-STARTPTS")
    elif offset > 0:
        parts.append(f"adelay=delays={offset}S:all=1")
    parts.append(f"apad=whole_len={frames}")
    parts.append(f"atrim=end_sample={frames}")
    return ",".join(parts)


def _input_args(
    raw: Path,
    placement: float,
    frames: int,
    rate: int,
    channels: int,
) -> list[str]:
    raw_end = placement + wav_frames(raw) / rate
    if raw_end <= 0 or placement * TAKE_RATE >= frames:
        # Nothing lands inside the song: a silent lane of the right length.
        silence = f"anullsrc=r={TAKE_RATE}:cl=stereo"
        return ["-f", "lavfi", "-i", silence, "-af", f"atrim=end_sample={frames}"]
    return ["-i", str(raw), "-af", take_audio_filter(placement, frames, channels)]


def _run(cmd: list[str], context: str) -> None:
    proc = subprocess.run(  # noqa: S603 -- list args, no shell, trusted ffmpeg
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=TIMEOUT_FFMPEG,
    )
    if proc.returncode != 0:
        tail = proc.stderr[-FFMPEG_STDERR_TAIL_BYTES:].decode("utf-8", "replace")
        raise TakeRenderError(f"ffmpeg failed [{context}]: {tail}")


def render_take_audio(
    raw: Path,
    dest: Path,
    placement_sec: float,
    frames: int,
    source_rate: int,
    source_channels: int,
) -> None:
    """Render `dest` (audio.wav) from `raw` (audio.raw.wav), atomically."""
    tmp = dest.with_name(f".{dest.name}.{uuid.uuid4().hex}.tmp{WAV_EXT}")
    try:
        try:
            inputs = _input_args(raw, placement_sec, frames, source_rate, source_channels)
        except (OSError, RuntimeError) as exc:
            raise TakeRenderError(f"raw take unreadable: {exc}") from exc
        cmd = [ffmpeg_executable(), "-nostdin", "-loglevel", "error", *inputs]
        cmd += ["-ac", str(TAKE_CHANNELS), "-ar", str(TAKE_RATE), "-c:a", "pcm_s16le"]
        cmd += ["-f", "wav", "-y", str(tmp)]
        _run(cmd, f"take audio {raw.parent.name}")
        os.replace(tmp, dest)
    finally:
        tmp.unlink(missing_ok=True)


def write_take_peaks(wav: Path, dest: Path, take_id: str) -> None:
    """The take's waveform in stems/peaks.json's shape, under its own name."""
    peaks, _rms = scan_stem(wav, TAKE_PEAK_POINTS)
    write_json_atomic(dest, {take_id: peaks})
