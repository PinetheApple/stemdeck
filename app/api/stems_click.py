"""The click as an export option on the stems routes.

Two parts, kept out of stems.py so that module stays about the stems:

- The click query parameters, defined once. Every route that renders a click
  (a stem region, the mix and video exports, the stems zip) takes them under the
  same names with the same bounds, defaults and descriptions. Each `click_*_query()`
  builds a fresh `Query` per route: FastAPI mutates the instance it binds (its
  alias), so one instance must never be shared between routes.
- The stems zip's click file: the isolated click track, rendered from the grid
  the app clicks to with the same rate, accents, grouping, level and sound as
  the click in a mix export. It starts at the song's first sample like every
  stem, with the stems' length, rate and channels, so it lines up with them in
  any player, and the zip's files at unity sum to the mix export. A count-in is
  not part of it: the stems in a zip are not delayed.

`run_ffmpeg` is the one blocking file-to-file ffmpeg call the zip makes, for the
stems' transcodes and the click alike. Nothing here imports stems.py, which
imports this module.
"""

from __future__ import annotations

import subprocess
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import NamedTuple

import soundfile as sf
from fastapi import HTTPException, Query

from app.core.config import (
    CLICK_GAIN_DEFAULT,
    CLICK_GAIN_MAX,
    CLICK_GROUPS_MAX_CHARS,
    CLICK_MULT_DEFAULT,
    CLICK_SOUND_ID_MAX_CHARS,
    CLICK_STEM_NAME,
    EXPORT_ENCODE_ARGS,
    EXTRA_STEM_NAMES,
    FFMPEG_MUXER_WAV,
    RENDERED_TRACK_NAMES,
    STEM_NAMES,
    TEMPO_MAX_BEATS_PER_BAR,
    TIMEOUT_FFMPEG,
    ffmpeg_executable,
)
from app.pipeline.click_render import ACCENT_AUTO, CLICK_TO_STEREO, render_click_wav
from app.pipeline.click_sounds import CLICK_SOUND_IDS, DEFAULT_CLICK_SOUND

# The click file shares the zip's namespace with the stems: refuse to start
# rather than let it overwrite one.
if CLICK_STEM_NAME in (*STEM_NAMES, *EXTRA_STEM_NAMES, *RENDERED_TRACK_NAMES):
    raise RuntimeError("CLICK_STEM_NAME collides with a stem name")

ZIP_WORK_PREFIX = ".zipwork-"
_FFMPEG_STDERR_TAIL_BYTES = 2000
_STEREO_CHANNELS = 2

CLICK_MIX_DESCRIPTION = "Mix the click track into the export"
CLICK_FILE_DESCRIPTION = "Add the click track as its own file"
CLICK_MULT_DESCRIPTION = "Click rate: 0.5, 1 or 2"
CLICK_ACCENT_DESCRIPTION = "-1 auto, 0 off, N per bar"
CLICK_GAIN_DESCRIPTION = "Click level"
CLICK_GROUPS_DESCRIPTION = (
    'Beat grouping for an explicit meter, e.g. "3+2+2". Blank uses the default.'
)
CLICK_SOUND_DESCRIPTION = (
    "Click sound preset id (static/js/clickSounds.js). Defaults to the classic click, "
    "which is what a client that predates presets sends."
)


def click_mix_query():
    return Query(default=False, description=CLICK_MIX_DESCRIPTION)


def click_file_query():
    return Query(default=False, description=CLICK_FILE_DESCRIPTION)


def click_mult_query():
    return Query(default=CLICK_MULT_DEFAULT, description=CLICK_MULT_DESCRIPTION)


def click_accent_query():
    return Query(
        default=ACCENT_AUTO,
        ge=ACCENT_AUTO,
        le=TEMPO_MAX_BEATS_PER_BAR,
        description=CLICK_ACCENT_DESCRIPTION,
    )


def click_gain_query():
    return Query(
        default=CLICK_GAIN_DEFAULT,
        ge=0,
        le=CLICK_GAIN_MAX,
        description=CLICK_GAIN_DESCRIPTION,
    )


def click_groups_query():
    return Query(
        default="",
        max_length=CLICK_GROUPS_MAX_CHARS,
        description=CLICK_GROUPS_DESCRIPTION,
    )


def click_sound_query():
    return Query(
        default=DEFAULT_CLICK_SOUND,
        max_length=CLICK_SOUND_ID_MAX_CHARS,
        description=CLICK_SOUND_DESCRIPTION,
    )


def check_click_sound(sound: str) -> str:
    """The click sound id, validated against the preset whitelist.

    The id is only ever used as a key into the preset table and a cache-key
    suffix, never in a path or a command, but it is still refused outright
    rather than defaulted: a client asking for a sound it cannot have should
    hear about it, not get the classic click without a word."""
    if sound not in CLICK_SOUND_IDS:
        raise HTTPException(status_code=422, detail="unknown click sound")
    return sound


def click_level_filter(gain: float, channels: int = _STEREO_CHANNELS) -> str:
    """The ffmpeg filter that sets the mono click's level; for stereo, the click
    on both channels at unity, as Web Audio up-mixes it live."""
    upmix = f",{CLICK_TO_STEREO}" if channels == _STEREO_CHANNELS else ""
    return f"volume={gain:.6f}{upmix}"


def zip_work_dir(dest: Path) -> tempfile.TemporaryDirectory:
    """Scratch space for building the zip at `dest`: beside it, so the startup
    sweep finds what a killed build left."""
    return tempfile.TemporaryDirectory(prefix=ZIP_WORK_PREFIX, dir=dest.parent)


def run_ffmpeg(src: Path, out: Path, output_args: Sequence[str]) -> None:
    """Blocking: ffmpeg from `src` to `out`, with `output_args` (filters,
    codec, muxer) between them. Raises RuntimeError with the tail of ffmpeg's
    stderr when it fails."""
    cmd = [
        ffmpeg_executable(),
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(src),
        *output_args,
        str(out),
    ]
    proc = subprocess.run(  # noqa: S603 — list args, no shell, trusted ffmpeg
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=TIMEOUT_FFMPEG,
    )
    if proc.returncode != 0:
        tail = proc.stderr[-_FFMPEG_STDERR_TAIL_BYTES:].decode("utf-8", "replace")
        raise RuntimeError(f"ffmpeg failed for {out.name}: {tail}")


class ClickStem(NamedTuple):
    """What the zip's click file is rendered from: the choices the click in a
    mix export is rendered from, so the two click identically. `grid` is the
    one the app clicks to (stems._read_beat_grid), None when the song has none."""

    grid: dict | None
    gain: float
    multiplier: float
    accent_mode: int
    groups: list[int] | None
    sound: str


def render_click_stem(
    click: ClickStem,
    reference: Path,
    workdir: Path,
) -> Path | None:
    """Blocking: the click file as a 16-bit WAV in `workdir`, with exactly the
    frame count, rate and channels `reference` decodes to, at `click.gain`.
    None when there is no grid or it has no beats."""
    beats = (click.grid or {}).get("beats") or []
    if not beats:
        return None
    info = sf.info(str(reference))
    frames, rate = int(info.frames), int(info.samplerate)
    raw = render_click_wav(
        workdir / "click_mono.wav",
        beats,
        click.grid.get("bars") or [],
        frames / rate,
        sample_rate=rate,
        multiplier=click.multiplier,
        accent_mode=click.accent_mode,
        groups=click.groups,
        sound=click.sound,
        frames=frames,
    )
    if raw is None:
        return None
    out = workdir / f"{CLICK_STEM_NAME}.{FFMPEG_MUXER_WAV}"
    run_ffmpeg(
        raw,
        out,
        [
            "-af",
            click_level_filter(click.gain, info.channels),
            *EXPORT_ENCODE_ARGS[FFMPEG_MUXER_WAV],
            "-f",
            FFMPEG_MUXER_WAV,
        ],
    )
    return out


@contextmanager
def click_stem_sources(
    click: ClickStem | None,
    reference: Path,
    dest: Path,
) -> Iterator[list[tuple[str, Path]]]:
    """The click file as zip sources, `[(CLICK_STEM_NAME, path)]`, for the zip
    being built at `dest`; empty, with nothing rendered or created, when the
    click is off or there is nothing to click. `reference` is a stem: every
    stem has the song's frame count."""
    if click is None:
        yield []
        return
    with zip_work_dir(dest) as td:
        path = render_click_stem(click, reference, Path(td))
        yield [] if path is None else [(CLICK_STEM_NAME, path)]
