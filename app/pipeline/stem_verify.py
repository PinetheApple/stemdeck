"""Encoding one stem to MP3, and proving the MP3 is the same audio before the
WAV it came from may be deleted (app/pipeline/stem_storage.py).

libmp3lame adds an encoder delay and padding. ffmpeg writes both into the
LAME/Xing header of the first frame (-write_xing 1, its default, made explicit
below), and ffmpeg, libsndfile (mpg123) and Chromium's decodeAudioData all trim
by it, so a decoded MP3 starts on the same sample as the WAV and has the same
length. `verify_mp3` checks exactly that with both server-side decoders, then
checks the loudest block lines up at lag 0, so a decoder or encoder that got
the header wrong never costs a song its WAVs.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
import soundfile as sf

from app.core.config import (
    STEM_FORMAT_MP3,
    STEM_VERIFY_BLOCK_SEC,
    STEM_VERIFY_MAX_LAG,
    STEM_VERIFY_MIN_CORR,
    STEM_VERIFY_MIN_RATIO,
    STEM_VERIFY_MIN_RMS,
    TIMEOUT_FFMPEG,
    ffmpeg_executable,
)
from app.core.models import Job, JobCancelled
from app.core.registry import set_proc
from app.pipeline.cancel import run_registered

# ffmpeg's frame count is taken from raw 16-bit PCM it streams out.
_PCM_BYTES_PER_SAMPLE = 2
_READ_CHUNK_BYTES = 1 << 20


class StemStorageError(RuntimeError):
    """The MP3 could not be made or did not verify. The WAV stays."""


def encode_cmd(src: Path, dest: Path, kbps: int) -> list[str]:
    """One stem to CBR MP3. Module-level seam: tests swap in a stub encoder."""
    return [
        ffmpeg_executable(),
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-map",
        "0:a:0",
        "-c:a",
        "libmp3lame",
        "-b:a",
        f"{kbps}k",
        "-write_xing",
        "1",
        "-f",
        STEM_FORMAT_MP3,
        "-y",
        str(dest),
    ]


def encode_mp3(job: Job, src: Path, dest: Path, kbps: int) -> None:
    """Encode `src` to `dest`, registered so a cancel stops it. Raises
    JobCancelled or StemStorageError."""
    try:
        proc = run_registered(job, encode_cmd(src, dest, kbps), TIMEOUT_FFMPEG)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise StemStorageError(f"the MP3 encoder did not finish {src.name}") from exc
    if job.cancel_requested:
        raise JobCancelled()
    if proc.returncode != 0 or not dest.is_file():
        raise StemStorageError(f"the MP3 encoder failed on {src.name}")


def verify_mp3(job: Job, wav: Path, mp3: Path) -> None:
    """Raise StemStorageError unless `mp3` decodes to `wav`'s exact length in
    both libsndfile and ffmpeg, at its rate and channel count, and its loudest
    block lines up with the WAV's."""
    try:
        ref = sf.info(str(wav))
        got = sf.info(str(mp3))
    except Exception as exc:  # libsndfile raises its own types
        raise StemStorageError("the MP3 cannot be read by libsndfile") from exc
    if (got.samplerate, got.channels) != (ref.samplerate, ref.channels):
        raise StemStorageError("the MP3 has another rate or channel count")
    if got.frames != ref.frames:
        raise StemStorageError(f"libsndfile decodes {got.frames} frames, the WAV has {ref.frames}")
    ff = ffmpeg_frames(job, mp3, ref.channels)
    if ff != ref.frames:
        raise StemStorageError(f"ffmpeg decodes {ff} frames, the WAV has {ref.frames}")
    _check_alignment(wav, mp3, ref.samplerate * STEM_VERIFY_BLOCK_SEC)


def ffmpeg_frames(job: Job, path: Path, channels: int) -> int:
    """Frames ffmpeg decodes `path` to, counted as they stream past."""
    cmd = [
        ffmpeg_executable(),
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(path),
        "-map",
        "0:a:0",
        "-ac",
        str(channels),
        "-f",
        "s16le",
        "-",
    ]
    proc = subprocess.Popen(  # noqa: S603 -- list args, no shell, trusted ffmpeg
        cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL
    )
    set_proc(job.id, proc)
    try:
        total = _drain(proc)
    finally:
        set_proc(job.id, None)
    if job.cancel_requested:
        raise JobCancelled()
    if proc.returncode != 0:
        raise StemStorageError("the MP3 does not decode")
    return total // (_PCM_BYTES_PER_SAMPLE * channels)


def _drain(proc: subprocess.Popen) -> int:
    total = 0
    assert proc.stdout is not None
    while chunk := proc.stdout.read(_READ_CHUNK_BYTES):
        total += len(chunk)
    try:
        proc.wait(timeout=TIMEOUT_FFMPEG)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise StemStorageError("the MP3 check did not finish") from None
    return total


def _check_alignment(wav: Path, mp3: Path, block: int) -> None:
    try:
        a, b = _loudest_block(wav, mp3, block)
    except StemStorageError:
        raise
    except Exception as exc:
        raise StemStorageError("the MP3 cannot be read back") from exc
    if a is None or b is None or float(np.sqrt(np.mean(a * a))) < STEM_VERIFY_MIN_RMS:
        return
    zero, best, lag = _correlation(a, b, STEM_VERIFY_MAX_LAG)
    if zero < STEM_VERIFY_MIN_CORR or zero < STEM_VERIFY_MIN_RATIO * best:
        raise StemStorageError(
            f"the MP3 does not line up with the WAV (lag {lag}, {zero:.3f} at 0 against {best:.3f})"
        )


def _loudest_block(wav: Path, mp3: Path, size: int) -> tuple[np.ndarray | None, np.ndarray | None]:
    """Channel 0 of the loudest `size`-frame block of `wav`, and the same block
    of `mp3`, read side by side in one pass. (None, None) for an empty file."""
    best_rms = -1.0
    best: tuple[np.ndarray | None, np.ndarray | None] = (None, None)
    pairs = zip(
        sf.blocks(str(wav), blocksize=size, dtype="float32", always_2d=True),
        sf.blocks(str(mp3), blocksize=size, dtype="float32", always_2d=True),
        strict=True,
    )
    for a, b in pairs:
        if len(a) != len(b):
            raise StemStorageError("the MP3 reads back at another length")
        a0 = a[:, 0].astype(np.float64)
        rms = float(np.sqrt(np.mean(a0 * a0))) if a0.size else 0.0
        if rms > best_rms:
            best_rms, best = rms, (a0, b[:, 0].astype(np.float64))
    return best


def _correlation(a: np.ndarray, b: np.ndarray, max_lag: int) -> tuple[float, float, int]:
    """Normalised cross-correlation of b against a: its value at lag 0, its
    best value within +-max_lag, and that lag."""
    n = len(a)
    nfft = 1 << (2 * n).bit_length()
    c = np.fft.irfft(np.fft.rfft(b, nfft) * np.conj(np.fft.rfft(a, nfft)), nfft)
    denom = float(np.sqrt(np.sum(a * a) * np.sum(b * b)))
    if denom <= 0:
        return 0.0, 0.0, 0
    k = min(max_lag, n - 1)
    window = np.concatenate([c[-k:], c[: k + 1]]) / denom if k else c[:1] / denom
    i = int(np.argmax(window))
    return float(c[0] / denom), float(window[i]), i - k
