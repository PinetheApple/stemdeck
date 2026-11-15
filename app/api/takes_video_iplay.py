"""The backing of a filmed take's export without what the player played.

"I play" names stems; vocals stands for both of its halves. A lane that is
an I-play stem is dropped. A vocals lane with one half played keeps the
other half. An original lane, the complement of what the mixer selected,
is rebuilt from its parts when a played stem is inside it, the same move
the export makes for a transposed original; a missing part is a 422.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import NamedTuple

from fastapi import HTTPException

from app.api.stems import effective_pitch
from app.api.takes_lanes import is_take_lane
from app.core.config import STEM_NAMES
from app.core.take_video_config import ORIGINAL, VOCAL_HALVES, VOCALS


class Lane(NamedTuple):
    name: str
    gain: float
    pitch: int


def played_set(i_play: list[str]) -> set[str]:
    played = set(i_play)
    if VOCALS in played:
        played |= set(VOCAL_HALVES)
    return played


def _inside_original(names: list[str]) -> list[str]:
    selected = set(names)
    if set(VOCAL_HALVES) <= selected:
        selected.add(VOCALS)
    return [n for n in STEM_NAMES if n not in selected]


def _audible(name: str, played: set[str]) -> list[str]:
    """The stems that sound for `name` once the played ones are taken out."""
    if name in played:
        return []
    if name == VOCALS and played & set(VOCAL_HALVES):
        return [h for h in VOCAL_HALVES if h not in played]
    return [name]


def _need(names: list[str], exists: Callable[[str], bool]) -> list[str]:
    missing = [n for n in names if not exists(n)]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"cannot leave out the played part: {', '.join(missing)} missing",
        )
    return names


def _rebuilt_original(lane: Lane, inside: list[str], played: set[str], exists) -> list[Lane]:
    parts = _need([s for n in inside for s in _audible(n, played)], exists)
    return [Lane(p, lane.gain, effective_pitch(p, lane.pitch)) for p in parts]


def _hidden_in(inside: list[str]) -> set[str]:
    return set(inside) | (set(VOCAL_HALVES) if VOCALS in inside else set())


def _original(lane: Lane, inside: list[str], played: set[str], exists) -> list[Lane]:
    """Rebuilt here when transposed too: the export would take its complement
    from the rewritten lane names, which can bring a played half back."""
    if played & _hidden_in(inside):
        return _rebuilt_original(lane, inside, played, exists)
    if lane.pitch and all(exists(n) for n in inside):
        return [Lane(n, lane.gain, effective_pitch(n, lane.pitch)) for n in inside]
    # Without its parts the export keeps it in the original key, as playback does.
    return [Lane(lane.name, lane.gain, 0)]


def _rewrite(lane: Lane, inside: list[str], played: set[str], exists) -> list[Lane]:
    if lane.name == ORIGINAL:
        return _original(lane, inside, played, exists)
    audible = _audible(lane.name, played)
    if audible == [lane.name]:
        return [lane]
    return [Lane(n, lane.gain, lane.pitch) for n in _need(audible, exists)]


def without_played(
    lanes: list[Lane],
    i_play: list[str],
    exists: Callable[[str], bool],
) -> list[Lane]:
    """`lanes` with every played stem taken out; `exists` says whether this
    song has a stem's file."""
    played = played_set(i_play)
    inside = _inside_original([lane.name for lane in lanes])
    out: list[Lane] = []
    for lane in lanes:
        out += [lane] if is_take_lane(lane.name) else _rewrite(lane, inside, played, exists)
    return out
