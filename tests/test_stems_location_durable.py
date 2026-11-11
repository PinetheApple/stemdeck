"""A library move that a crash, a full disk or a refused file stops partway.

Across drives every entry is copied under a temporary name, checked and only
then renamed, and the originals stay until the new location is saved. The old
folder is whole until then, and a retry picks up where the move stopped.
"""

from __future__ import annotations

import errno
import shutil
from pathlib import Path

import pytest

from app.core import stems_location
from app.core.config import SETLISTS_FILE
from app.core.models import Job
from app.core.stems_location import StemsLocationError, move_library, validate_target
from tests.test_stems_location import _isolate_registry, _job_dir, client  # noqa: F401
from tests.test_stems_location_records import _write_registry


@pytest.fixture
def other_drive(monkeypatch):
    """Every rename refused the way one across drives is, so the move copies."""
    import os

    def rename(src, dst):
        raise OSError(errno.EXDEV, "Invalid cross-device link")

    monkeypatch.setattr(os, "rename", rename)


_MARKER = stems_location._MOVE_MARKER


def _snapshot(root: Path) -> dict[str, bytes]:
    """The library's files, without the marker of a move still in progress."""
    return {
        p.relative_to(root).as_posix(): p.read_bytes()
        for p in root.rglob("*")
        if p.is_file() and p.name != _MARKER
    }


def _entries(root: Path) -> list[str]:
    return sorted(p.name for p in root.iterdir() if p.name != _MARKER)


def _library(root: Path) -> dict[str, bytes]:
    """Two songs and the registry, as the move finds them."""
    _job_dir(root, "aaaaaaaaaaaa", size=64)
    _job_dir(root, "bbbbbbbbbbbb", size=64)
    (root / "bbbbbbbbbbbb" / "stems" / "drums.wav").write_bytes(b"D" * 64)
    _write_registry(root, Job(id="aaaaaaaaaaaa", status="done", favorite=True))
    return _snapshot(root)


def _copy_failing_at(monkeypatch, n: int, failure: BaseException) -> dict[str, bool]:
    """The n-th file copied stops half written, with `failure`, while the
    returned switch's "fail" is on."""
    real = shutil.copyfile
    count = {"n": 0}
    switch = {"fail": True}

    def copyfile(src, dst, **kw):
        count["n"] += 1
        if switch["fail"] and count["n"] == n:
            Path(dst).write_bytes(Path(src).read_bytes()[:3])
            raise failure
        return real(src, dst, **kw)

    monkeypatch.setattr(shutil, "copyfile", copyfile)
    return switch


def _corrupt_copies_of(monkeypatch, name: str, corrupt) -> None:
    """Every copy of a file called `name` reports success with `corrupt` bytes."""
    real = shutil.copyfile

    def copyfile(src, dst, **kw):
        real(src, dst, **kw)
        if Path(src).name == name:
            Path(dst).write_bytes(corrupt(Path(dst).read_bytes()))

    monkeypatch.setattr(shutil, "copyfile", copyfile)


class _Killed(BaseException):
    """The process dying: no except clause sees it, so nothing tidies up."""


@pytest.mark.parametrize("name", [".DS_Store", "desktop.ini", "Thumbs.db"])
def test_accepts_a_folder_holding_only_what_the_os_left_there(tmp_path, name):
    """Finder and Explorer write these into any folder they show. None is
    someone else's file, and none is moved over or deleted."""
    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa")
    target = tmp_path / "new"
    target.mkdir()
    (target / name).write_bytes(b"theirs")
    (current / name).write_bytes(b"mine")

    assert validate_target(target, current) == target.resolve()
    move_library(current, target)

    assert (target / name).read_bytes() == b"theirs"
    assert (current / name).read_bytes() == b"mine"
    assert (target / "aaaaaaaaaaaa" / "stems" / "vocals.wav").is_file()


@pytest.mark.parametrize("left", [b"RR", b"\0" * 32], ids=["cut short", "full size, lost data"])
def test_a_partial_copy_from_an_earlier_attempt_is_replaced(tmp_path, left):
    """A song an earlier move left cut short under its real name used to be
    taken as finished, so the retry reported the move done."""
    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa", size=32)
    target = tmp_path / "new"
    partial = target / "aaaaaaaaaaaa" / "stems"
    partial.mkdir(parents=True)
    (partial / "vocals.wav").write_bytes(left)

    result = move_library(current, target)
    stems_location.remove_moved(result)

    assert (target / "aaaaaaaaaaaa" / "stems" / "vocals.wav").read_bytes() == b"R" * 32


def test_a_move_killed_mid_copy_leaves_the_old_library_whole_and_can_be_finished(
    tmp_path, monkeypatch, other_drive
):
    current = tmp_path / "old"
    before = _library(current)
    target = tmp_path / "new"
    power = _copy_failing_at(monkeypatch, 3, _Killed())

    with pytest.raises(_Killed):
        move_library(current, target)

    assert _snapshot(current) == before, "nothing is taken from the old library mid-move"
    assert not (target / "bbbbbbbbbbbb").exists(), "no song cut short under its real name"
    power["fail"] = False

    result = move_library(current, target)

    assert _snapshot(target) == before
    assert _snapshot(current) == before, "the originals wait until the setting is saved"
    stems_location.remove_moved(result)
    assert list(current.iterdir()) == []


@pytest.mark.parametrize(
    ("name", "entry", "corrupt"),
    [
        ("drums.wav", "bbbbbbbbbbbb", lambda data: data[:10]),
        ("registry.json", "registry.json", lambda data: data[:-2] + b"!!"),
    ],
    ids=["short song file", "registry with flipped bytes"],
)
def test_a_copy_that_does_not_match_its_original_is_not_used(
    tmp_path, monkeypatch, other_drive, name, entry, corrupt
):
    """A network share that reports success for a short or garbled write."""
    current = tmp_path / "old"
    before = _library(current)
    target = tmp_path / "new"
    _corrupt_copies_of(monkeypatch, name, corrupt)

    with pytest.raises(StemsLocationError, match=f"Could not move {entry}"):
        move_library(current, target)

    assert _snapshot(current) == before
    assert not (target / entry).exists()


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (OSError(28, "No space left on device"), "No space left on device"),
        (PermissionError(13, "Permission denied"), "Permission denied"),
        # Its text carries the full path; strerror is None.
        (shutil.SpecialFileError("`/Users/me/jobs/x` is a named pipe"), "it could not be copied"),
    ],
)
def test_a_copy_that_fails_keeps_the_old_library_and_the_setting(
    client,  # noqa: F811
    tmp_path,
    monkeypatch,
    other_drive,
    failure,
    reason,
):
    import app.core.settings as settings_mod

    before = _library(client.jobs_dir)
    target = tmp_path / "elsewhere"
    _copy_failing_at(monkeypatch, 3, failure)

    r = client.post("/api/settings/stems-location", json={"path": str(target)})

    assert r.status_code == 500
    detail = r.json()["detail"]
    assert detail.startswith(f"Could not move bbbbbbbbbbbb: {reason}.")
    assert str(tmp_path) not in detail, "no paths in errors"
    assert _snapshot(client.jobs_dir) == before
    assert _entries(target) == ["aaaaaaaaaaaa"], "no half copy left"
    assert settings_mod.get_jobs_dir() is None
    assert stems_location.is_relocating() is False


def test_the_originals_are_removed_only_once_the_new_location_is_saved(
    client,  # noqa: F811
    tmp_path,
    monkeypatch,
    other_drive,
):
    import app.core.settings as settings_mod

    before = _library(client.jobs_dir)
    target = tmp_path / "elsewhere"
    monkeypatch.setattr(settings_mod, "_save", lambda: False)

    body = client.post("/api/settings/stems-location", json={"path": str(target)}).json()

    assert body["persisted"] is False
    assert _snapshot(client.jobs_dir) == before, "a restart reads this folder, so it stays whole"
    assert _snapshot(target) == before


def test_a_move_across_drives_drains_the_old_folder(client, tmp_path, other_drive):  # noqa: F811
    before = _library(client.jobs_dir)
    target = tmp_path / "elsewhere"

    r = client.post("/api/settings/stems-location", json={"path": str(target)})

    assert r.status_code == 200, r.text
    assert r.json()["moved_entries"] == 3
    assert _snapshot(target) == before
    assert list(client.jobs_dir.iterdir()) == []


def _link_out_of(song: Path, outside: Path, kind: str) -> Path:
    import os
    import subprocess

    link = song / "elsewhere"
    if kind == "junction":
        if os.name != "nt":
            pytest.skip("junctions are a Windows thing")
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True
        )
        return link
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not available here")
    return link


@pytest.mark.parametrize("kind", ["junction", "symlink"])
def test_a_link_inside_the_library_is_never_followed_out_of_it(tmp_path, other_drive, kind):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("not the library's", encoding="utf-8")
    current = tmp_path / "old"
    link = _link_out_of(_job_dir(current, "aaaaaaaaaaaa"), outside, kind)
    target = tmp_path / "new"

    with pytest.raises(StemsLocationError, match="Could not move aaaaaaaaaaaa: a link"):
        move_library(current, target)

    assert _entries(target) == [], "nothing from outside is copied in"
    assert (outside / "secret.txt").read_text(encoding="utf-8") == "not the library's"
    assert stems_location._is_link(link), "the link itself stays where it was"
    assert (current / "aaaaaaaaaaaa" / "stems" / "vocals.wav").is_file()


def test_an_unfinished_copy_of_any_entry_is_cleared_by_the_retry(tmp_path):
    """A crash mid-copy leaves `.<entry>.moving` in the target. It must not make
    the retry refuse the folder as someone else's, whatever the entry is."""
    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa")
    (current / ".registry.0f1e2d.tmp").write_text("{}", encoding="utf-8")
    target = tmp_path / "new"
    target.mkdir()
    (target / "..registry.0f1e2d.tmp.moving").write_text("{", encoding="utf-8")

    assert validate_target(target, current) == target.resolve()
    move_library(current, target)

    assert not (target / "..registry.0f1e2d.tmp.moving").exists()
    assert (target / ".registry.0f1e2d.tmp").read_text(encoding="utf-8") == "{}"


def test_a_dot_moving_file_that_is_no_copy_of_ours_is_still_someone_elses(tmp_path):
    current = tmp_path / "old"
    _job_dir(current, "aaaaaaaaaaaa")
    target = tmp_path / "new"
    target.mkdir()
    (target / ".my-notes.moving").write_text("mine", encoding="utf-8")

    with pytest.raises(StemsLocationError, match="empty folder"):
        validate_target(target, current)


def test_a_library_can_be_pointed_at_from_a_folder_with_no_songs(client, tmp_path):  # noqa: F811
    """Settings were lost while the library's drive was unplugged, so StemDeck
    started in its default folder and wrote a registry there. Picking the
    library again points at it and carries nothing over the real one."""
    import app.core.settings as settings_mod

    stray = _write_registry(client.jobs_dir, Job(id="dddddddddddd", status="done"))
    (client.jobs_dir / "user-data.json").write_text('{"stray": 1}', encoding="utf-8")
    library = tmp_path / "external-drive" / "StemDeck"
    _job_dir(library, "aaaaaaaaaaaa")
    real = _write_registry(library, Job(id="aaaaaaaaaaaa", status="done", favorite=True))
    (library / "user-data.json").write_text('{"real": 1}', encoding="utf-8")

    r = client.post("/api/settings/stems-location", json={"path": str(library)})

    assert r.status_code == 200, r.text
    assert r.json()["moved_entries"] == 0
    assert (library / "registry.json").read_text(encoding="utf-8") == real
    assert (library / "user-data.json").read_text(encoding="utf-8") == '{"real": 1}'
    assert (client.jobs_dir / "registry.json").read_text(encoding="utf-8") == stray
    assert settings_mod.get_jobs_dir() == str(library.resolve())


def test_a_folder_with_songs_still_refuses_another_library(tmp_path):
    """Pointing away from a folder that holds songs would leave them behind."""
    current = tmp_path / "default"
    _job_dir(current, "dddddddddddd")
    _write_registry(current, Job(id="dddddddddddd", status="done"))
    library = tmp_path / "library"
    _job_dir(library, "aaaaaaaaaaaa")
    _write_registry(library, Job(id="aaaaaaaaaaaa", status="done"))

    with pytest.raises(StemsLocationError, match="already holds another StemDeck library"):
        validate_target(library, current)


def test_a_move_whose_setting_did_not_save_can_be_retried_after_new_writes(
    client,  # noqa: F811
    tmp_path,
    monkeypatch,
    other_drive,
):
    """The setting failed to save, so the app kept writing to the old folder and
    its records now differ from the copies in the target: still our own move."""
    import app.core.settings as settings_mod

    _library(client.jobs_dir)
    target = tmp_path / "elsewhere"
    real_save = settings_mod._save
    monkeypatch.setattr(settings_mod, "_save", lambda: False)
    assert (
        client.post("/api/settings/stems-location", json={"path": str(target)}).json()["persisted"]
        is False
    )
    newer = _write_registry(client.jobs_dir, Job(id="bbbbbbbbbbbb", status="done", favorite=True))
    (client.jobs_dir / SETLISTS_FILE).write_text('{"edited": 1}', encoding="utf-8")
    monkeypatch.setattr(settings_mod, "_save", real_save)

    r = client.post("/api/settings/stems-location", json={"path": str(target)})

    assert r.status_code == 200, r.text
    assert (target / "registry.json").read_text(encoding="utf-8") == newer
    assert (target / SETLISTS_FILE).read_text(encoding="utf-8") == '{"edited": 1}'
    assert list(client.jobs_dir.iterdir()) == []
    assert sorted(p.name for p in target.iterdir()) == [
        "aaaaaaaaaaaa",
        "bbbbbbbbbbbb",
        "registry.json",
        SETLISTS_FILE,
    ], "no marker left once the move is saved"


def test_records_from_a_move_that_died_after_copying_them_are_not_another_library(
    tmp_path, monkeypatch, other_drive
):
    """The app died after the registry was copied; on the next start it wrote
    to the old folder again, so the two registries now differ."""
    current = tmp_path / "old"
    _library(current)
    (current / "user-data.json").write_text('{"mine": 1}', encoding="utf-8")
    target = tmp_path / "new"
    _copy_failing_at(monkeypatch, 5, _Killed())
    with pytest.raises(_Killed):
        move_library(current, target)
    assert (target / "registry.json").is_file() and not (target / "user-data.json").exists()
    _write_registry(current, Job(id="bbbbbbbbbbbb", status="done"))

    assert validate_target(target, current) == target.resolve()


def _our_marker(target: Path, current: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    (target / _MARKER).write_text(str(current.resolve()), encoding="utf-8")


def test_a_linked_records_file_is_refused_even_under_our_marker(tmp_path):
    current = tmp_path / "old"
    _library(current)
    target = tmp_path / "new"
    _our_marker(target, current)
    elsewhere = tmp_path / "elsewhere.json"
    elsewhere.write_text('{"jobs": []}', encoding="utf-8")
    try:
        (target / "registry.json").symlink_to(elsewhere)
    except OSError:
        pytest.skip("symlinks are not available here")

    with pytest.raises(StemsLocationError, match="another StemDeck library"):
        validate_target(target, current)


def _linked_marker(target: Path, current: Path, outside: Path) -> None:
    target.mkdir(parents=True)
    outside.write_text(str(current.resolve()), encoding="utf-8")
    try:
        (target / _MARKER).symlink_to(outside)
    except OSError:
        pytest.skip("symlinks are not available here")


def test_a_linked_marker_is_refused_and_never_written_through(tmp_path):
    current = tmp_path / "old"
    _library(current)
    target = tmp_path / "new"
    outside = tmp_path / "outside.txt"
    _linked_marker(target, current, outside)

    with pytest.raises(StemsLocationError):
        validate_target(target, current)
    with pytest.raises(StemsLocationError):
        move_library(current, target)
    assert outside.read_text(encoding="utf-8") == str(current.resolve())
    assert _entries(target) == []


@pytest.mark.parametrize(
    "content",
    [b"/" + b"a" * 8192, b"\xff\xfe not text", b"relative/path", b"/old\n/other", b"/old\0"],
    ids=["oversized", "not utf-8", "relative", "two lines", "nul"],
)
def test_a_marker_that_is_not_a_plain_path_is_refused(tmp_path, content):
    current = tmp_path / "old"
    _library(current)
    target = tmp_path / "new"
    target.mkdir()
    (target / _MARKER).write_bytes(content)

    with pytest.raises(StemsLocationError):
        validate_target(target, current)


def test_a_marker_that_cannot_be_removed_keeps_the_originals(tmp_path, monkeypatch, other_drive):
    """A marker left behind naming this folder would later let its empty
    registry overwrite the new library's on a move back, so the originals are
    deleted only once the marker is gone."""
    current = tmp_path / "old"
    before = _library(current)
    target = tmp_path / "new"
    result = move_library(current, target)
    real_unlink = Path.unlink

    def unlink(self, *a, **kw):
        if self.name == _MARKER:
            raise PermissionError(13, "Access is denied")
        return real_unlink(self, *a, **kw)

    monkeypatch.setattr(Path, "unlink", unlink)
    stems_location.remove_moved(result)

    assert _snapshot(current) == before
