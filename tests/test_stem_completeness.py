"""A song comes back as done only when its separation finished
(upstream PR 901, #88).

collect() moves the stems in one at a time, and original.wav, mix.wav, the
beat grid and the lyrics come after it. restore() took any folder holding one
stem for a finished song, so a kill at any of those steps brought an
incomplete song back as "done". The last thing a run writes is now
stems/.complete.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core import registry as _registry
from app.core.models import Job
from app.core.registry import registry_path
from app.core.song_folder import STEMS_COMPLETE
from app.pipeline.runner import _run_local_blocking

JOB = "a1b2c3d4e5f6"


@pytest.fixture(autouse=True)
def _isolate_registry():
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()
    yield
    _registry._jobs.clear()
    _registry._deleted.clear()
    _registry._pending_resume.clear()


def _stems(root: Path, names=("vocals", "drums"), *, complete: bool, meta: bool) -> Path:
    stems = root / JOB / "stems"
    stems.mkdir(parents=True)
    for name in names:
        (stems / f"{name}.wav").write_bytes(b"RIFF")
    if complete:
        (stems / STEMS_COMPLETE).write_text("", encoding="utf-8")
    if meta:
        (root / JOB / "metadata.json").write_text(json.dumps({"title": "T"}), encoding="utf-8")
    return stems


def _record(root: Path, version: int = 2, **kw) -> None:
    record = Job(id=JOB, title="T", **kw).to_record()
    body = {"version": version, "jobs": [record]}
    registry_path(root).write_text(json.dumps(body), encoding="utf-8")


def test_a_separation_cut_off_part_way_is_not_rebuilt_as_done(tmp_path: Path):
    _stems(tmp_path, ("vocals",), complete=False, meta=False)

    _registry.restore(tmp_path)

    assert _registry.get(JOB) is None
    assert (tmp_path / JOB / "stems" / "vocals.wav").is_file()


def test_an_upload_cut_off_part_way_comes_back_stopped(tmp_path: Path):
    _stems(tmp_path, ("vocals",), complete=False, meta=False)
    (tmp_path / JOB / "source.wav").write_bytes(b"RIFF")

    _registry.restore(tmp_path)

    assert _registry.get(JOB).status == "stopped"


def test_a_running_job_cut_off_part_way_runs_again(tmp_path: Path):
    _stems(tmp_path, ("vocals",), complete=False, meta=False)
    _record(tmp_path, status="separating")

    _registry.restore(tmp_path)

    assert _registry.get(JOB).status == "queued"
    assert _registry.take_pending_resume() == [JOB]


@pytest.mark.parametrize(("complete", "meta"), [(True, False), (False, True), (True, True)])
def test_a_finished_separation_is_rebuilt_as_done(tmp_path: Path, complete, meta):
    """The marker alone is the crash before metadata.json; metadata.json alone
    is a song made before the marker."""
    _stems(tmp_path, complete=complete, meta=meta)

    _registry.restore(tmp_path)

    assert _registry.get(JOB).status == "done"


def test_a_song_the_registry_holds_as_done_gets_the_marker_on_upgrade(tmp_path: Path):
    stems = _stems(tmp_path, complete=False, meta=False)
    _record(tmp_path, version=1, status="done")

    _registry.restore(tmp_path)

    assert (stems / STEMS_COMPLETE).is_file()


def test_the_marker_is_backfilled_only_once(tmp_path: Path):
    """Not on every start: that stats and globs every finished song."""
    stems = _stems(tmp_path, complete=False, meta=False)
    _record(tmp_path, version=2, status="done")

    _registry.restore(tmp_path)

    assert not (stems / STEMS_COMPLETE).exists()


def test_a_cut_off_separation_in_a_current_library_is_still_not_done(tmp_path: Path):
    _stems(tmp_path, ("vocals",), complete=False, meta=False)
    registry_path(tmp_path).write_text(json.dumps({"version": 2, "jobs": []}))

    _registry.restore(tmp_path)

    assert _registry.get(JOB) is None


def test_a_lone_lead_vocal_is_not_a_split(tmp_path: Path):
    _stems(tmp_path, ("vocals", "drums", "lead_vocals"), complete=True, meta=True)

    _registry.restore(tmp_path)

    names = [stem["name"] for stem in _registry.get(JOB).stems]
    assert "lead_vocals" not in names
    assert _registry.get(JOB).vocal_split == "none"


def _run(tmp_path: Path, side_effect=None) -> Path:
    job = Job(id=JOB, source_url="local:song.wav")
    job_dir = tmp_path / JOB
    stems = job_dir / "stems"
    stems.mkdir(parents=True)
    (stems / "vocals.wav").write_bytes(b"RIFF")
    source = job_dir / "source.wav"
    with (
        patch("app.pipeline.runner._prepare_local_source", return_value=source),
        patch("app.pipeline.runner._run_with_band_lookup", side_effect=side_effect),
    ):
        _run_local_blocking(job, source, job_dir)
    return stems / STEMS_COMPLETE


def test_a_run_marks_its_stems_complete_last(tmp_path: Path):
    assert _run(tmp_path).is_file()


def test_a_run_that_fails_leaves_no_marker(tmp_path: Path):
    with pytest.raises(RuntimeError):
        _run(tmp_path, side_effect=RuntimeError("demucs died"))

    assert not (tmp_path / JOB / "stems" / STEMS_COMPLETE).exists()
