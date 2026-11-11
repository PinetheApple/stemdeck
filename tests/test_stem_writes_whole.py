"""Stem audio is written whole or not at all (upstream PR 898, #88).

ffmpeg wrote original.wav and mix.wav at their final names, and the Lead +
Backing worker wrote straight into stems/. A kill part way through left a
truncated file there that a song rebuilt from its folder took for a whole
stem.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from app.core.models import Job
from app.pipeline import collect
from app.pipeline import vocal_split as vs_mod
from app.pipeline.vocal_split import VocalSplitFailed

PARTIAL = b"RIFF-cut-off"


@pytest.fixture()
def stems_dir(tmp_path: Path) -> Path:
    stems = tmp_path / "stems"
    stems.mkdir()
    for name in ("vocals", "drums", "bass", "other"):
        (stems / f"{name}.wav").write_bytes(b"RIFF")
    return stems


def _ffmpeg(monkeypatch, ok: bool) -> list[Path]:
    """ffmpeg that writes to its output path, then succeeds or fails."""
    outputs: list[Path] = []

    def run(job, cmd):
        out = Path(cmd[-1])
        outputs.append(out)
        out.write_bytes(PARTIAL)
        return ok

    monkeypatch.setattr(collect, "_run_ffmpeg", run)
    return outputs


def _make(kind: str, stems_dir: Path) -> Path | None:
    job = Job(id="a1b2c3d4e5f6", selected_stems=["vocals", "drums"])
    if kind == "original":
        return collect.make_original_track(job, stems_dir.parent, stems_dir)
    return collect.make_selected_mix(job, stems_dir, ["vocals", "drums", "bass", "other"])


def _leftovers(stems_dir: Path) -> list[str]:
    return sorted(p.name for p in stems_dir.iterdir() if p.name.startswith("."))


@pytest.mark.parametrize(("kind", "name"), [("original", "original.wav"), ("mix", "mix.wav")])
def test_a_failed_mix_leaves_no_file_that_reads_as_a_stem(stems_dir, monkeypatch, kind, name):
    outputs = _ffmpeg(monkeypatch, ok=False)

    assert _make(kind, stems_dir) is None

    assert outputs[0] != stems_dir / name
    assert not (stems_dir / name).exists()
    assert _leftovers(stems_dir) == []


@pytest.mark.parametrize(("kind", "name"), [("original", "original.wav"), ("mix", "mix.wav")])
def test_a_mix_moves_in_once_ffmpeg_finished(stems_dir, monkeypatch, kind, name):
    _ffmpeg(monkeypatch, ok=True)

    assert _make(kind, stems_dir) == stems_dir / name

    assert (stems_dir / name).read_bytes() == PARTIAL
    assert _leftovers(stems_dir) == []


_WORKER = """
import os, sys
out_dir = sys.argv[3]
open(os.path.join(out_dir, "lead_vocals.wav"), "wb").write(b"RIFF")
open(os.path.join(out_dir, "backing_vocals.wav"), "wb").write(b"RIFF")
sys.stderr.write("@@DONE@@\\n")
"""


def _worker(monkeypatch) -> list[Path]:
    out_dirs: list[Path] = []

    def spawn_cmd(device: str, vocals_path: Path, out_dir: Path) -> list[str]:
        out_dirs.append(out_dir)
        return [sys.executable, "-c", _WORKER, device, str(vocals_path), str(out_dir)]

    monkeypatch.setattr(vs_mod, "_spawn_cmd", spawn_cmd)
    monkeypatch.setattr(vs_mod, "get_demucs_device", lambda: "cpu")
    return out_dirs


def _split(stems_dir: Path) -> list[str]:
    job = Job(id="a1b2c3d4e5f6", status="done")
    return vs_mod.split_vocals(job, stems_dir, cancelled=lambda: False, report=lambda pct: None)


def test_the_split_worker_writes_outside_the_stems(stems_dir, monkeypatch):
    """A kill mid-split then leaves no lead_vocals.wav that reads as a stem."""
    out_dirs = _worker(monkeypatch)

    assert _split(stems_dir) == ["lead_vocals", "backing_vocals"]

    assert out_dirs[0] != stems_dir
    assert (stems_dir / "lead_vocals.wav").is_file()
    assert (stems_dir / "backing_vocals.wav").is_file()
    assert _leftovers(stems_dir) == []


def test_a_pair_that_cannot_move_in_takes_back_the_half_that_did(stems_dir, monkeypatch):
    _worker(monkeypatch)
    real = os.replace

    def replace(src, dst):
        if Path(dst).name == "backing_vocals.wav":
            raise OSError("disk full")
        real(src, dst)

    monkeypatch.setattr(os, "replace", replace)

    with pytest.raises(VocalSplitFailed):
        _split(stems_dir)

    assert not (stems_dir / "lead_vocals.wav").exists()
    assert _leftovers(stems_dir) == []
