"""Moving the library with the copies the desktop shell's save keeps beside
user-data.json: the previous file (.bak), a save that stopped partway (.tmp) and
damaged files it set aside (.corrupt-<n>). They travel with the store, and a
folder holding only such a copy is not one StemDeck used.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core import stems_location
from app.core.stems_location import StemsLocationError, move_library, remove_moved, validate_target
from tests.test_stems_location import _isolate_registry, _job_dir  # noqa: F401

_STORE_COPIES = ["user-data.json.bak", "user-data.json.tmp", "user-data.json.corrupt-1"]
_SONG = "aaaaaaaaaaaa"


def _folders(tmp_path: Path) -> tuple[Path, Path]:
    current = tmp_path / "old"
    _job_dir(current, _SONG)
    target = tmp_path / "new"
    target.mkdir()
    return current, target


@pytest.mark.parametrize("name", _STORE_COPIES)
def test_accepts_a_folder_with_the_copies_the_user_data_save_keeps(tmp_path, name):
    current = tmp_path / "old"
    current.mkdir()
    target = tmp_path / "new"
    _job_dir(target, "abcdefabcdef")
    (target / "user-data.json").write_text("{}", encoding="utf-8")
    (target / name).write_text("{}", encoding="utf-8")
    assert validate_target(target, current) == target.resolve()


@pytest.mark.parametrize("name", _STORE_COPIES)
def test_refuses_a_folder_holding_only_a_copy_of_the_user_data_store(tmp_path, name):
    current, target = _folders(tmp_path)
    (target / name).write_text('{"theirs": 1}', encoding="utf-8")
    with pytest.raises(StemsLocationError, match="empty folder"):
        validate_target(target, current)


@pytest.mark.parametrize("name", _STORE_COPIES)
def test_refuses_a_folder_whose_store_copy_differs_from_ours(tmp_path, name):
    current, target = _folders(tmp_path)
    (current / name).write_text('{"mine": 1}', encoding="utf-8")
    _job_dir(target, "abcdefabcdef")
    (target / "registry.json").write_text("{}", encoding="utf-8")
    (target / name).write_text('{"theirs": 1}', encoding="utf-8")
    with pytest.raises(StemsLocationError, match="another StemDeck library"):
        validate_target(target, current)


def test_a_move_takes_the_store_copies_along(tmp_path):
    current, target = _folders(tmp_path)
    names = ["user-data.json", *_STORE_COPIES]
    for name in names:
        (current / name).write_text(f'{{"{name}": 1}}', encoding="utf-8")

    validate_target(target, current)
    remove_moved(move_library(current, target))

    for name in names:
        assert (target / name).read_text(encoding="utf-8") == f'{{"{name}": 1}}'
        assert not (current / name).exists(), name


def test_a_move_replaces_a_stale_store_copy_at_the_target(tmp_path):
    """Once our user-data.json is at the target, our copies replace different
    ones there: the target's would restore the wrong library on a recovery."""
    current, target = _folders(tmp_path)
    (current / "user-data.json").write_text('{"mine": 2}', encoding="utf-8")
    (current / "user-data.json.bak").write_text('{"mine": 1}', encoding="utf-8")
    (target / "user-data.json.bak").write_text('{"stale": 1}', encoding="utf-8")

    remove_moved(move_library(current, target))

    assert (target / "user-data.json").read_text(encoding="utf-8") == '{"mine": 2}'
    assert (target / "user-data.json.bak").read_text(encoding="utf-8") == '{"mine": 1}'
    assert not (current / "user-data.json.bak").exists()


def test_a_move_keeps_the_target_copy_when_our_store_did_not_get_there(tmp_path):
    current, target = _folders(tmp_path)
    (current / "user-data.json").write_text('{"mine": 2}', encoding="utf-8")
    (current / "user-data.json.bak").write_text('{"mine": 1}', encoding="utf-8")
    (target / "user-data.json").write_text('{"theirs": 2}', encoding="utf-8")
    (target / "user-data.json.bak").write_text('{"theirs": 1}', encoding="utf-8")

    remove_moved(move_library(current, target))

    assert (target / "user-data.json.bak").read_text(encoding="utf-8") == '{"theirs": 1}'
    assert (current / "user-data.json.bak").read_text(encoding="utf-8") == '{"mine": 1}'


def test_a_move_skips_an_entry_that_vanished_since_the_listing(tmp_path, monkeypatch):
    """The shell renames its .tmp away at the end of every save, so it can be
    gone by its turn: skipped, not a failed move."""
    current, target = _folders(tmp_path)
    (current / "user-data.json.tmp").write_text("{}", encoding="utf-8")
    real_stat = Path.stat

    def vanishing_stat(self, *args, **kwargs):
        # Only the bare stat of the size check: is_dir() and exists() pass arguments.
        if not args and not kwargs and self.name == "user-data.json.tmp":
            self.unlink(missing_ok=True)
            raise FileNotFoundError(2, "gone", str(self))
        return real_stat(self, *args, **kwargs)

    monkeypatch.setattr(Path, "stat", vanishing_stat)
    move_library(current, target)
    monkeypatch.setattr(Path, "stat", real_stat)

    assert (target / _SONG / "stems" / "vocals.wav").is_file()
    assert not (target / "user-data.json.tmp").exists()


def test_a_move_skips_an_entry_that_vanishes_before_its_rename(tmp_path, monkeypatch):
    current, target = _folders(tmp_path)
    (current / "user-data.json.tmp").write_text("{}", encoding="utf-8")
    real_renamed = stems_location._renamed

    def vanishing_renamed(entry, destination):
        if entry.name == "user-data.json.tmp":
            entry.unlink()
            return False  # as a rename refused across drives: the copy follows
        return real_renamed(entry, destination)

    monkeypatch.setattr(stems_location, "_renamed", vanishing_renamed)
    move_library(current, target)

    assert (target / _SONG / "stems" / "vocals.wav").is_file()
    assert not (target / "user-data.json.tmp").exists()
