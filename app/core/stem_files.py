"""Where a stem's audio file is, whatever format the song keeps it in.

A library holds songs stored as WAV (every song by default) and songs stored as
MP3 (the opt-in Stem storage format, upstream PR 822). Every reader that opens
a stem of a finished song goes through `stem_path`, so none of them needs to
know which kind of song it has.

The rule is the file on disk, WAV first:

- A WAV song has `<name>.wav`. It may also have `<name>.mp3`, the download
  cache GET /stems/{name}.mp3 writes beside the WAV, which must never shadow it.
- An MP3 song has only `<name>.mp3`: its WAVs are deleted once the MP3s are
  verified and on the disk (app/pipeline/stem_storage.py).
- While that step runs, and if it fails, the WAVs are still there and win.

So the answer is right in every state a song's folder can be in, without
reading the job record or the current setting.
"""

from __future__ import annotations

import contextlib
import subprocess
from collections.abc import Iterator
from pathlib import Path

from app.core.config import STEM_FORMAT_MP3, STEM_FORMAT_WAV, TIMEOUT_FFMPEG, ffmpeg_executable

WAV_EXT = f".{STEM_FORMAT_WAV}"
MP3_EXT = f".{STEM_FORMAT_MP3}"
# In the order they are looked for. WAV first: see the module docstring.
STEM_EXTS: tuple[str, ...] = (WAV_EXT, MP3_EXT)

_MEDIA_TYPES = {WAV_EXT: "audio/wav", MP3_EXT: "audio/mpeg"}
_UNKNOWN_MEDIA_TYPE = "application/octet-stream"


class StemDecodeError(RuntimeError):
    """ffmpeg could not decode a stem to WAV."""


def stem_path(stems_dir: Path, name: str) -> Path:
    """The file holding stem `name`: `<name>.wav` when it exists, else
    `<name>.mp3` when that exists, else the `.wav` path, which does not exist,
    so a caller's own is_file() check fails as it always did.

    `name` must already be whitelisted by the caller."""
    for ext in STEM_EXTS:
        path = stems_dir / f"{name}{ext}"
        if path.is_file():
            return path
    return stems_dir / f"{name}{WAV_EXT}"


def stem_exists(stems_dir: Path, name: str) -> bool:
    return stem_path(stems_dir, name).is_file()


def stem_ext(path: Path) -> str:
    """ "wav" or "mp3" for a stem file."""
    return path.suffix.lower().removeprefix(".")


def stem_media_type(path: Path) -> str:
    return _MEDIA_TYPES.get(path.suffix.lower(), _UNKNOWN_MEDIA_TYPE)


def stem_url(job_id: str, stems_dir: Path, name: str) -> str:
    """The URL the page loads stem `name` from, ending in the file's own
    extension so the browser and a download both get the right type."""
    return f"/api/jobs/{job_id}/stems/{name}.{stem_ext(stem_path(stems_dir, name))}"


def is_stem_audio(path: Path) -> bool:
    """A stem file, WAV or MP3. Dot-prefixed temps are not stems."""
    return path.suffix.lower() in STEM_EXTS and not path.name.startswith(".")


def holds_stem_audio(stems_dir: Path) -> bool:
    return stems_dir.is_dir() and any(is_stem_audio(p) for p in stems_dir.iterdir())


@contextlib.contextmanager
def decoded_wav(path: Path, folder: Path) -> Iterator[Path]:
    """`path` itself when it is a WAV, else a float32 WAV that ffmpeg decoded
    it to inside `folder`, removed afterwards.

    For a reader that hands the stem to a library that may not decode MP3 the
    way ffmpeg does (the vocal split's audio-separator). Raises StemDecodeError
    when the decode fails."""
    if path.suffix.lower() == WAV_EXT:
        yield path
        return
    out = folder / f"{path.stem}{WAV_EXT}"
    try:
        _decode(path, out)
        yield out
    finally:
        out.unlink(missing_ok=True)


def _decode(src: Path, dest: Path) -> None:
    cmd = [
        ffmpeg_executable(),
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(src),
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_f32le",
        "-f",
        STEM_FORMAT_WAV,
        "-y",
        str(dest),
    ]
    try:
        proc = subprocess.run(  # noqa: S603 -- list args, no shell, trusted ffmpeg
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=TIMEOUT_FFMPEG,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise StemDecodeError(f"could not decode {src.name}") from exc
    if proc.returncode != 0 or not dest.is_file():
        raise StemDecodeError(f"could not decode {src.name}")
