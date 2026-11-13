"""Moving the library into a folder that holds another library's records.

The move skips an entry already at the target, so another library's
registry.json, user-data.json or setlists file there would leave ours behind.
Such a folder is refused before anything moves; a half-finished move of this
same library can still be finished.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.core.config import SETLISTS_FILE
from app.core.models import Job
from app.core.stems_location import StemsLocationError, move_library, validate_target
from tests.test_stems_location import _isolate_registry, _job_dir, client  # noqa: F401
from tests.test_versions_api import THREE_OPEN, THREE_VERSIONS

_REFUSED = "already holds another StemDeck library"


def _write_registry(folder: Path, job: Job) -> str:
    text = json.dumps({"version": 1, "jobs": [job.to_record()]})
    (folder / "registry.json").write_text(text, encoding="utf-8")
    return text


def _fail_on(monkeypatch, entry_name: str) -> dict[str, bool]:
    """One entry cannot be moved, the way a full disk stops it, while the
    returned switch's "fail" is on: its rename is refused, and so is every file
    the copy that follows reads."""
    import os
    import shutil

    real_rename, real_copy = os.rename, shutil.copyfile
    switch = {"fail": True}

    def stopped(src) -> bool:
        return switch["fail"] and entry_name in Path(src).parts

    def rename(src, dst):
        if stopped(src):
            raise OSError(18, "Invalid cross-device link")
        return real_rename(src, dst)

    def copyfile(src, dst, **kw):
        if stopped(src):
            raise OSError(28, "No space left on device")
        return real_copy(src, dst, **kw)

    monkeypatch.setattr(os, "rename", rename)
    monkeypatch.setattr(shutil, "copyfile", copyfile)
    return switch


def test_moving_into_another_stemdeck_library_keeps_both_registries_records(tmp_path):
    from app.core import registry as _registry
    from app.core.registry import _jobs as jobs

    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa")
    mine = _write_registry(
        current, Job(id="aaaaaaaaaaaa", status="done", title="Mine", favorite=True)
    )
    target = tmp_path / "other-library"
    _job_dir(target, "cccccccccccc")
    theirs = _write_registry(target, Job(id="cccccccccccc", status="done", title="Theirs"))

    with pytest.raises(StemsLocationError, match=_REFUSED):
        validate_target(target, current)

    assert (current / "registry.json").read_text(encoding="utf-8") == mine
    assert (target / "registry.json").read_text(encoding="utf-8") == theirs
    assert (current / "aaaaaaaaaaaa" / "stems" / "vocals.wav").is_file()
    assert (target / "cccccccccccc" / "stems" / "vocals.wav").is_file()
    assert not (target / "aaaaaaaaaaaa").exists()
    jobs.clear()
    _registry.restore(current)
    restored = _registry.get("aaaaaaaaaaaa")
    assert restored is not None
    assert restored.favorite is True, "our favourite must still be where it was"


@pytest.mark.parametrize("records", ["user-data.json", SETLISTS_FILE])
def test_another_librarys_other_records_are_refused_too(tmp_path, records):
    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa")
    (current / records).write_text('{"mine": 1}', encoding="utf-8")
    target = tmp_path / "other-library"
    _job_dir(target, "cccccccccccc")
    (target / records).write_text('{"theirs": 1}', encoding="utf-8")

    with pytest.raises(StemsLocationError, match=_REFUSED):
        validate_target(target, current)


def test_a_linked_registry_in_the_target_is_refused(tmp_path):
    """A link could point at our own registry and look identical."""
    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa")
    (current / "registry.json").write_text('{"jobs": []}', encoding="utf-8")
    target = tmp_path / "new"
    target.mkdir()
    try:
        (target / "registry.json").symlink_to(current / "registry.json")
    except OSError:
        pytest.skip("symlinks are not available here")

    with pytest.raises(StemsLocationError, match=_REFUSED):
        validate_target(target, current)


def test_a_registry_copied_but_not_yet_removed_is_our_own_progress(tmp_path):
    """A move across drives copies, then deletes the source. Interrupted between
    the two, both folders hold the same registry, and the retry must go on."""
    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa")
    text = _write_registry(current, Job(id="aaaaaaaaaaaa", status="done"))
    target = tmp_path / "new"
    _job_dir(target, "aaaaaaaaaaaa")
    (target / "registry.json").write_text(text, encoding="utf-8")

    assert validate_target(target, current) == target.resolve()


def test_a_folder_holding_another_library_is_refused_by_the_endpoint(client, tmp_path):  # noqa: F811
    import app.core.settings as settings_mod
    from app.core import stems_location

    _job_dir(client.jobs_dir, "aaaaaaaaaaaa")
    mine = _write_registry(client.jobs_dir, Job(id="aaaaaaaaaaaa", status="done"))
    other = tmp_path / "other-library"
    _job_dir(other, "cccccccccccc")
    theirs = _write_registry(other, Job(id="cccccccccccc", status="done"))

    r = client.post("/api/settings/stems-location", json={"path": str(other)})

    assert r.status_code == 422
    assert r.json() == {
        "detail": "That folder already holds another StemDeck library. "
        "Pick an empty folder instead."
    }
    assert (client.jobs_dir / "registry.json").read_text(encoding="utf-8") == mine
    assert (other / "registry.json").read_text(encoding="utf-8") == theirs
    assert (client.jobs_dir / "aaaaaaaaaaaa").is_dir()
    assert not (other / "aaaaaaaaaaaa").exists()
    assert settings_mod.get_jobs_dir() is None
    assert stems_location.is_relocating() is False


def test_a_move_that_failed_after_the_registry_can_still_be_finished(
    client,  # noqa: F811
    tmp_path,
    monkeypatch,
):
    """The registry moves before user-data.json, so a move that stops on the
    last entry leaves our registry.json in the target: our own progress."""
    import app.core.settings as settings_mod

    _job_dir(client.jobs_dir, "aaaaaaaaaaaa")
    mine = _write_registry(client.jobs_dir, Job(id="aaaaaaaaaaaa", status="done"))
    (client.jobs_dir / "user-data.json").write_text('{"mine": 1}', encoding="utf-8")
    target = tmp_path / "elsewhere"
    disk = _fail_on(monkeypatch, "user-data.json")
    assert (
        client.post("/api/settings/stems-location", json={"path": str(target)}).status_code == 500
    )
    assert (target / "registry.json").is_file()
    assert not (client.jobs_dir / "registry.json").exists()
    disk["fail"] = False

    r = client.post("/api/settings/stems-location", json={"path": str(target)})

    assert r.status_code == 200, r.text
    assert r.json()["moved_entries"] == 1
    assert (target / "registry.json").read_text(encoding="utf-8") == mine
    assert (target / "user-data.json").read_text(encoding="utf-8") == '{"mine": 1}'
    assert list(client.jobs_dir.iterdir()) == []
    assert settings_mod.get_jobs_dir() == str(target.resolve())


def test_versions_move_with_the_library(tmp_path):
    from app.core import registry as _registry
    from app.core.registry import _jobs as jobs

    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa")
    song = Job(
        id="aaaaaaaaaaaa",
        status="done",
        title="Mine",
        versions=THREE_VERSIONS,
        open_version=THREE_OPEN,
    )
    _write_registry(current, song)
    target = tmp_path / "new"

    move_library(current, target)
    jobs.clear()
    _registry.restore(target)

    moved = _registry.get("aaaaaaaaaaaa")
    assert (moved.versions, moved.open_version) == (THREE_VERSIONS, THREE_OPEN)
