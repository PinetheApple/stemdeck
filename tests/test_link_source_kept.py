"""A link import keeps its downloaded audio as the song's source.

The download stays in the song's folder as source.<ext>, moved nowhere and
copied never; a .webm is remuxed to source.opus, packets untouched, so it is a
container the rest of the app reads. A failed or cancelled import keeps none,
an upload keeps only its source.wav, and the kept file never makes a link song
an upload.
"""

from __future__ import annotations

import json
import subprocess
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core import registry as _registry
from app.core.config import ffmpeg_executable
from app.core.models import Job, JobCancelled
from app.core.registry import is_upload
from app.core.song_folder import FAILED_DIR_NAME
from app.pipeline.runner import run_local_pipeline, run_pipeline
from tests.ffmpeg_probe import ffmpeg_available

LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
JOB_ID = "abcdef210210"
TONE_SECONDS = 2

needs_ffmpeg = pytest.mark.skipif(not ffmpeg_available(), reason="needs ffmpeg")


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()


def _tone(dest: Path, *codec: str) -> Path:
    subprocess.run(
        [
            ffmpeg_executable(),
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={TONE_SECONDS}",
            *codec,
            str(dest),
        ],
        check=True,
    )
    return dest


def _packets_md5(path: Path) -> str:
    """The audio packets' checksum: equal only when nothing was re-encoded."""
    result = subprocess.run(
        [
            ffmpeg_executable(),
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:a",
            "-c",
            "copy",
            "-f",
            "md5",
            "-",
        ],
        capture_output=True,
        check=True,
    )
    return result.stdout.decode().strip()


def _stub_stages(stack: ExitStack, job_dir: Path, separate_effect=None) -> None:
    """Every stage after the download, but keeping the source, stubbed."""

    def separate(job, source, jdir):
        if separate_effect is not None:
            raise separate_effect
        return jdir / "model"

    def collect(job, stems_root, jdir):
        (jdir / "stems").mkdir(exist_ok=True)
        (jdir / "stems" / "drums.wav").write_bytes(b"RIFF")
        return ["drums"]

    runner = "app.pipeline.runner"
    for name, value in (
        ("analyze", None),
        ("separate", separate),
        ("collect", collect),
        ("refine_key_from_stems", None),
        ("make_original_track", None),
        ("make_selected_mix", None),
        ("compute_stem_peaks", {}),
        ("compute_beat_grid", None),
        ("transcribe_lyrics", None),
        ("retime_after_separation", None),
        ("store_stems", False),
    ):
        side = value if callable(value) else None
        stack.enter_context(patch(f"{runner}.{name}", side_effect=side, return_value=value))
    stack.enter_context(patch(f"{runner}.IdentifyLookup.start", return_value=None))
    stack.enter_context(patch(f"{runner}.LyricsLookup.start", return_value=None))


async def _import_link(tmp_path: Path, download: Path, separate_effect=None) -> Job:
    job = Job(id=JOB_ID, source_url=LINK)
    job_dir = tmp_path / job.id

    def fake_download(job, url, jdir):
        target = jdir / f"source{download.suffix}"
        target.write_bytes(download.read_bytes())
        return target

    with ExitStack() as stack:
        _stub_stages(stack, job_dir, separate_effect)
        stack.enter_context(patch("app.pipeline.runner.download", side_effect=fake_download))
        await run_pipeline(job, LINK, tmp_path)
    return job


def _sources(directory: Path) -> list[str]:
    return sorted(p.name for p in directory.glob("source.*"))


@needs_ffmpeg
@pytest.mark.asyncio
@pytest.mark.parametrize("suffix", [".opus", ".m4a", ".mp3"])
async def test_a_link_import_keeps_its_download_as_is(tmp_path: Path, suffix: str):
    download = _tone(tmp_path / f"download{suffix}")

    job = await _import_link(tmp_path, download)

    assert job.status == "done"
    assert _sources(tmp_path / JOB_ID) == [f"source{suffix}"]
    assert (tmp_path / JOB_ID / f"source{suffix}").read_bytes() == download.read_bytes()


@needs_ffmpeg
@pytest.mark.asyncio
async def test_a_webm_download_is_remuxed_to_opus_without_re_encoding(tmp_path: Path):
    download = _tone(tmp_path / "download.webm", "-c:a", "libopus", "-b:a", "128k")

    job = await _import_link(tmp_path, download)

    assert job.status == "done"
    kept = tmp_path / JOB_ID / "source.opus"
    assert _sources(tmp_path / JOB_ID) == ["source.opus"]
    assert _packets_md5(kept) == _packets_md5(download)


@needs_ffmpeg
@pytest.mark.asyncio
@pytest.mark.parametrize("effect", [RuntimeError("separation blew up"), JobCancelled()])
async def test_a_failed_or_cancelled_link_import_keeps_no_source(tmp_path: Path, effect):
    download = _tone(tmp_path / "download.opus")

    job = await _import_link(tmp_path, download, separate_effect=effect)

    assert job.status in ("error", "cancelled")
    assert _sources(tmp_path / JOB_ID) == []
    assert _sources(tmp_path / FAILED_DIR_NAME / JOB_ID) == []


@needs_ffmpeg
@pytest.mark.asyncio
async def test_an_upload_keeps_only_its_wav(tmp_path: Path):
    job = Job(id=JOB_ID, source_url="local:song.mp3")
    job_dir = tmp_path / job.id
    job_dir.mkdir()
    upload = _tone(job_dir / "source.mp3")

    with ExitStack() as stack:
        _stub_stages(stack, job_dir)
        await run_local_pipeline(job, upload, tmp_path)

    assert job.status == "done"
    assert _sources(job_dir) == ["source.wav"]


def test_the_kept_link_source_is_the_retained_source(tmp_path: Path, monkeypatch):
    from app.api import jobs as jobs_mod

    monkeypatch.setattr(jobs_mod, "JOBS_DIR", tmp_path)
    job_dir = tmp_path / JOB_ID
    job_dir.mkdir()
    (job_dir / "source.opus").write_bytes(b"OggS")

    assert jobs_mod._retained_source(JOB_ID) == (job_dir / "source.opus").resolve()


def _link_song_folder(root: Path, *, stems: bool) -> Path:
    job_dir = root / JOB_ID
    job_dir.mkdir()
    (job_dir / "source.opus").write_bytes(b"OggS")
    meta = {"title": "A song", "source_url": LINK, "created_at": 1.0}
    (job_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    if stems:
        (job_dir / "stems").mkdir()
        (job_dir / "stems" / "drums.wav").write_bytes(b"RIFF")
    return job_dir


@pytest.mark.parametrize(("stems", "status"), [(True, "done"), (False, "stopped")])
def test_a_rebuilt_link_song_stays_a_link_song(tmp_path: Path, stems: bool, status: str):
    _link_song_folder(tmp_path, stems=stems)

    _registry.restore(tmp_path)

    job = _registry.get(JOB_ID)
    assert job.status == status
    assert job.source_url == LINK
    assert not is_upload(job)
