"""Moving the stems library to a different folder (#354).

Documents is a sensible default -- the library is the user's work, it belongs
somewhere visible that survives a reinstall -- but on macOS and Windows it is
also the folder most people have syncing to iCloud or OneDrive, and a stem
library is tens of gigabytes nobody agreed to spend on cloud storage.

Changing the location is not just a preference write. The registry lives inside
the stems folder, so leaving the existing library behind would make the app come
back empty with the files stranded. The move is the feature; the setting is
bookkeeping.
"""

from __future__ import annotations

import contextlib
import enum
import errno
import filecmp
import logging
import os
import shutil
import stat
from dataclasses import dataclass
from pathlib import Path

from app.core.config import SETLISTS_FILE
from app.core.settings import fsync_dir, fsync_file

logger = logging.getLogger("stemdeck.stems_location")


class StemsLocationError(ValueError):
    """Rejected before anything on disk was touched."""


# JOBS_DIR is bound at import time across the app, so a move leaves this process
# still writing to the folder the files just left. An import accepted in that
# window lands in the old folder and disappears from the library on the next
# start -- the stems are on disk, in a directory nothing looks at any more.
#
# Set before the move begins (which also closes the race against an import
# arriving mid-move) and never cleared on success: the restart is what clears
# it, and the restart is the point.
_relocating = False


def is_relocating() -> bool:
    return _relocating


def begin_relocation() -> None:
    global _relocating
    _relocating = True


def abandon_relocation() -> None:
    """The move failed, so the library is still where this process thinks it is
    and the app stays usable."""
    global _relocating
    _relocating = False


@dataclass(frozen=True)
class MoveResult:
    source: str
    target: str
    moved_entries: int
    bytes_moved: int
    same_filesystem: bool
    # Copied rather than renamed: their originals wait for remove_moved.
    copied: tuple[str, ...] = ()


def directory_size(path: Path) -> int:
    """Best-effort total size. Used to tell the user what they are about to move,
    so a failure to stat one file must not sink the whole answer."""
    total = 0
    for root, _dirs, files in os.walk(path, onerror=lambda _e: None):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                continue
    return total


def validate_target(target: Path, current: Path) -> Path:
    """Check a candidate location before anything is moved into it.

    Deliberately strict. This path becomes the root of a directory the app
    creates and deletes inside, and a careless answer here -- the user's home
    directory, or a folder already full of their own files -- turns a settings
    change into data loss.
    """
    if not str(target).strip():
        raise StemsLocationError("Pick a folder to store stems in.")

    target = Path(target).expanduser()
    if not target.is_absolute():
        raise StemsLocationError("The stems folder must be an absolute path.")
    target = target.resolve()
    current = current.expanduser().resolve()

    if target == current:
        raise StemsLocationError("Stems are already stored there.")
    if current in target.parents:
        # Moving a directory inside itself would recurse forever.
        raise StemsLocationError("Pick a folder outside the current stems folder.")

    if target.exists():
        if not target.is_dir():
            raise StemsLocationError("That path is a file, not a folder.")
        # An existing folder is fine only if it is empty or already ours: merging
        # a stem library into someone's Desktop is not a recoverable mistake.
        entries = list(target.iterdir())
        # user-data.json (#403): the library metadata store now lives inside
        # the jobs folder too (see desktop/src-tauri/src/main.rs's
        # documents_store_path), so re-selecting a folder StemDeck already
        # used must recognize it as "ours", same as registry.json.
        if entries and not all(_is_ours(e, current) for e in entries):
            raise StemsLocationError("Pick an empty folder, or one StemDeck already uses.")
        if _holds_another_library(target, current) and _holds_songs(current):
            raise StemsLocationError(
                "That folder already holds another StemDeck library. Pick an empty folder instead."
            )
    else:
        try:
            target.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise StemsLocationError(f"Cannot create that folder: {e.strerror or e}") from e

    if not os.access(target, os.W_OK):
        raise StemsLocationError("That folder is not writable.")
    return target


# move_library never writes over a file at the target, so with one of these in
# both folders ours would stay behind, and its favourites, tags or setlists with it.
_LIBRARY_RECORDS = ("registry.json", "user-data.json", SETLISTS_FILE)


def _holds_another_library(target: Path, current: Path) -> bool:
    """Whether the target has library records of its own that the move would
    leave ours behind for.

    A half-finished move of this same library is not another library: a renamed
    entry no longer exists in the source, so a records file present in only one
    place is our own progress. Both exist when a move across drives copied it
    and has not removed the original yet: identical, or ours anyway when the
    target's move marker names `current`.
    """
    ours = _moving_from(target) == str(current)
    for name in _LIBRARY_RECORDS:
        theirs = target / name
        mine = current / name
        if not os.path.lexists(theirs) or not mine.is_file():
            continue
        # A link in the target could point anywhere; never treat it as ours.
        if theirs.is_symlink() or not theirs.is_file():
            return True
        if ours:
            continue
        try:
            if not filecmp.cmp(mine, theirs, shallow=False):
                return True
        except OSError:
            return True
    return False


# Written in the target when a move starts and removed once the new location is
# saved, so the records an unfinished move copied there still read as ours.
_MOVE_MARKER = ".stemdeck-move-from"
# It holds one path; anything longer is not a marker StemDeck wrote.
_MARKER_MAX_BYTES = 4096
_MARKER_REFUSED = "That folder holds a file StemDeck did not expect. Pick an empty folder instead."
_OURS = frozenset({"registry.json", "failed", "user-data.json", SETLISTS_FILE, _MOVE_MARKER})
# What Finder and Explorer write into any folder they show.
_OS_FILES = frozenset({".ds_store", "desktop.ini", "thumbs.db"})


def _is_ours(entry: Path, current: Path) -> bool:
    """Whether an entry already in the target leaves it a folder StemDeck uses."""
    return (
        entry.name in _OURS
        or _looks_like_job_dir(entry)
        or entry.name.lower() in _OS_FILES
        or _partial_copy(entry.name, current)
    )


def _looks_like_job_dir(entry: Path) -> bool:
    from app.core.config import JOB_ID_RE

    return entry.is_dir() and bool(JOB_ID_RE.match(entry.name))


def _moving_from(target: Path) -> str | None:
    """The library the target's move marker names, or None without one. A linked,
    oversized or garbled marker is not StemDeck's: the folder is refused."""
    marker = target / _MOVE_MARKER
    if _is_link(marker):
        raise StemsLocationError(_MARKER_REFUSED)
    try:
        with open(marker, "rb") as fh:
            raw = fh.read(_MARKER_MAX_BYTES + 1)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise StemsLocationError(_MARKER_REFUSED) from e
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise StemsLocationError(_MARKER_REFUSED) from e
    if len(raw) > _MARKER_MAX_BYTES or not source.isprintable() or not Path(source).is_absolute():
        raise StemsLocationError(_MARKER_REFUSED)
    return source


def _mark_move(target: Path, current: Path) -> None:
    marker = target / _MOVE_MARKER
    if _is_link(marker):
        raise StemsLocationError(_MARKER_REFUSED)
    marker.write_text(str(current), encoding="utf-8")
    fsync_file(marker)
    fsync_dir(target)


def _holds_songs(folder: Path) -> bool:
    return folder.is_dir() and any(_looks_like_job_dir(e) for e in folder.iterdir())


def move_library(current: Path, target: Path) -> MoveResult:
    """Move every stem directory (and top-level file, e.g. registry.json and
    the desktop shell's user-data.json, #403) from `current` into `target`.

    Entry by entry rather than moving the folder itself: the folder may be one
    the user picked in a native dialog and expects to keep. This also means
    nothing here needs to know about user-data.json specifically -- it lives
    inside the jobs folder like any other entry, so it comes along for free.

    On the same drive an entry is renamed, which is atomic. Across drives it is
    copied under a temporary name, checked against the original, put on the
    disk and only then renamed to its real name, so a crash never leaves a song
    cut short under a name a later attempt would take as finished. The
    originals of copied entries stay (`MoveResult.copied`) until the caller has
    saved the new location and calls remove_moved: until then the old folder is
    whole and is still the one a restart reads.

    On a failure partway, whatever has already moved stays moved and the error
    names the entry that stopped it. A retry picks up where this stopped.
    """
    current = current.expanduser().resolve()
    target = target.expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    same_fs = _same_filesystem(current, target)
    # No song here and another library there: settings were lost while its drive
    # was away. Point at it and bring nothing, or a stray registry would win.
    if not current.exists() or (
        not _holds_songs(current) and _holds_another_library(target, current)
    ):
        return MoveResult(str(current), str(target), 0, 0, same_fs)
    # Records already in the target came from this move only under its marker.
    resumed = _moving_from(target) == str(current)
    _mark_move(target, current)
    _clear_partial_copies(target, current)
    moved, moved_bytes, copied = 0, 0, []
    for entry in sorted(current.iterdir()):
        size = directory_size(entry) if entry.is_dir() else entry.stat().st_size
        outcome = _move_entry(entry, target / entry.name, resumed)
        if outcome in (_Moved.COPIED, _Moved.ALREADY_THERE):
            copied.append(entry.name)
        if outcome in (_Moved.RENAMED, _Moved.COPIED):
            moved += 1
            moved_bytes += size
    return MoveResult(str(current), str(target), moved, moved_bytes, same_fs, tuple(copied))


class _Moved(enum.Enum):
    RENAMED = "renamed"
    COPIED = "copied"
    ALREADY_THERE = "already there"
    LEFT = "left where it is"


def _move_entry(entry: Path, destination: Path, resumed: bool) -> _Moved:
    """`resumed`: records at the destination are an earlier copy of ours, which
    the app may have written to since, so they are copied again."""
    try:
        if os.path.lexists(destination):
            if _holds_all_of(destination, entry):
                return _Moved.ALREADY_THERE
            ours = _looks_like_job_dir(entry) or (resumed and entry.name in _LIBRARY_RECORDS)
            if _is_link(entry) or not ours:
                # Such as the target's own .DS_Store: never written over.
                logger.info("stems move: a different %s is at the target", entry.name)
                return _Moved.LEFT
            # A song an earlier attempt cut short is copied again.
        elif _renamed(entry, destination):
            return _Moved.RENAMED
        _copy_verified(entry, destination)
    except OSError as e:
        # strerror only: str(e) of some OSErrors (shutil.SpecialFileError) holds a path.
        raise StemsLocationError(
            f"Could not move {entry.name}: {e.strerror or 'it could not be copied'}. "
            f"Anything already moved is in the new folder."
        ) from e
    return _Moved.COPIED


def remove_moved(result: MoveResult) -> None:
    """Delete the move marker, then the originals of the entries move_library
    copied, once the new location is saved. A marker left naming the old folder
    would let its records overwrite this library's on a later move back, so
    while it cannot be removed the originals stay. The records go first, so an
    old folder this stops partway through holds no registry that could later
    read as another library. One that cannot be deleted is only a leftover
    copy: logged."""
    try:
        (Path(result.target) / _MOVE_MARKER).unlink(missing_ok=True)
    except OSError:
        logger.warning("stems move: marker not removed; keeping the originals", exc_info=True)
        return
    current = Path(result.source)
    for name in sorted(result.copied, key=lambda n: n not in _LIBRARY_RECORDS):
        try:
            _remove(current / name)
        except OSError:
            logger.warning("stems move: could not remove the original of %s", name, exc_info=True)


# Windows' reparse tag for a junction, as shutil.rmtree checks it; only Windows'
# stat module names it.
_JUNCTION_TAG = getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)


def _is_link(path: Path) -> bool:
    """A symlink or a Windows junction. Neither is ever followed: what it points
    at is not the library's."""
    try:
        st = path.lstat()
    except OSError:
        return False
    if stat.S_ISLNK(st.st_mode):
        return True
    return os.name == "nt" and getattr(st, "st_reparse_tag", 0) == _JUNCTION_TAG


def _remove(path: Path) -> None:
    if path.is_dir() and not _is_link(path):
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _renamed(entry: Path, destination: Path) -> bool:
    try:
        os.rename(entry, destination)
    except OSError as e:
        # Another drive, or a rename the OS refused (a file held open on
        # Windows): copied instead.
        logger.debug("stems move: renaming %s refused (errno %s)", entry.name, e.errno)
        return False
    return True


# A copy across drives is written as `.<name>.moving` and renamed to <name> only
# once it is complete.
_PARTIAL = ".moving"

_LINK_REFUSED = "a link to a place outside the library cannot be moved to another drive"


def _partial_copy(name: str, current: Path) -> bool:
    """Whether `name` is an unfinished copy of one of the entries in `current`."""
    if not (name.startswith(".") and name.endswith(_PARTIAL)) or not current.is_dir():
        return False
    return name[1 : -len(_PARTIAL)] in os.listdir(current)


def _clear_partial_copies(target: Path, current: Path) -> None:
    for leftover in target.iterdir():
        if _partial_copy(leftover.name, current):
            _remove(leftover)


def _files(root: Path) -> dict[str, int]:
    """Every file under `root` by relative path, with its size. Links are not
    looked through."""
    found: dict[str, int] = {}
    pending = [root]
    while pending:
        for child in pending.pop().iterdir():
            if _is_link(child):
                continue
            if child.is_dir():
                pending.append(child)
            else:
                found[child.relative_to(root).as_posix()] = child.stat().st_size
    return found


def _holds_all_of(copy: Path, original: Path) -> bool:
    """Whether `copy` already has every file of `original`, byte for byte: the
    original is deleted on that answer. Every file rather than equality, as a
    crash while removing originals leaves `original` short of some."""
    if _is_link(copy) or _is_link(original):
        return False
    if original.is_dir():
        if not copy.is_dir():
            return False
        have = _files(copy)
        return all(
            have.get(rel) == size and filecmp.cmp(original / rel, copy / rel, shallow=False)
            for rel, size in _files(original).items()
        )
    return copy.is_file() and filecmp.cmp(original, copy, shallow=False)


def _copy_file(src: Path, dst: Path) -> None:
    shutil.copyfile(src, dst)
    fsync_file(dst)
    shutil.copystat(src, dst)


def _copy_tree(src: Path, dst: Path) -> None:
    dst.mkdir()
    for child in src.iterdir():
        if _is_link(child):
            raise OSError(errno.ELOOP, _LINK_REFUSED)
        if child.is_dir():
            _copy_tree(child, dst / child.name)
        else:
            _copy_file(child, dst / child.name)
    shutil.copystat(src, dst)
    fsync_dir(dst)


def _copy_verified(entry: Path, destination: Path) -> None:
    """Copy `entry` to `destination` so that a crash at any moment leaves
    either no copy under that name or a complete one on the disk. Sizes are
    checked for a folder, every byte for a file (registry.json,
    user-data.json)."""
    if _is_link(entry):
        raise OSError(errno.ELOOP, _LINK_REFUSED)
    partial = destination.with_name(f".{destination.name}{_PARTIAL}")
    try:
        if entry.is_dir():
            _copy_tree(entry, partial)
            matches = _files(partial) == _files(entry)
        else:
            _copy_file(entry, partial)
            matches = filecmp.cmp(entry, partial, shallow=False)
        if not matches:
            raise OSError(errno.EIO, "the copy does not match the original")
        if destination.is_dir() and not _is_link(destination):
            shutil.rmtree(destination)
        os.replace(partial, destination)
    except OSError:
        # The next attempt clears it too; the error that stopped the copy is
        # the one to report.
        with contextlib.suppress(OSError):
            _remove(partial)
        raise
    fsync_dir(destination.parent)


def _same_filesystem(a: Path, b: Path) -> bool:
    """Whether the move is a rename or a copy. Only used to set expectations in
    the UI, so an unanswerable question is answered with "assume the slow one"."""
    try:
        probe = a if a.exists() else a.parent
        other = b if b.exists() else b.parent
        return probe.stat().st_dev == other.stat().st_dev
    except OSError:
        return False
