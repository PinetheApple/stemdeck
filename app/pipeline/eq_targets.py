"""Target curves for Suggest EQ (the data is eq_targets.json).

A target is a third-octave spectrum shape: 31 levels in dB at the ISO 266
bands from 20 Hz to 20 kHz, on a scale where pink noise is flat. Only the
shape matters; the fitter (eq_fit.py) removes the overall level. A target is
a taste choice, not a fact: it says "this is a common balance", not "this is
correct".

Where the numbers come from:

- mix, Balanced (the "original" lane and the master): from 100 Hz up, the
  mean long-term average spectrum of 12,345 popular music tracks fitted by
  Elowsson and Friberg ("Long-term average spectrum in popular music and its
  relation to the level of the percussion", AES 142nd Convention, 2017),
  converted from power density to third-octave levels (+3 dB per octave).
  It is close to pink up to about 1 kHz and falls faster above, in line with
  Pestana et al. ("Spectral characteristics of popular commercial recordings
  1950-2010", AES 135th Convention, 2013). So it is not pink noise: music is
  darker than pink above 1 kHz, and a pink target would brighten every mix.
  Below 100 Hz the paper's mean falls steeply, and bass levels in popular
  music rose over the decades (Hove, Vuust and Stupacher, JASA 145(4), 2019),
  so the curve is set by hand to a gentler roll-off there (flat to 63 Hz,
  -6 dB at 40, -22 at 20). Above 15.7 kHz the fit is extrapolated.
- Warm and Bright: up to 3 dB less (more) above 4 kHz and 1 dB more (less)
  at 150-300 Hz. Full low end (mix only) adds up to 3 dB below 120 Hz.
- Instruments (bass, drums, guitar, keys, other): set by hand from common
  mixing practice for where each instrument sits, then compared with
  separated stems. No published per-instrument average exists; these are the
  weakest of the targets.
- target_lufs: the integrated loudness a master target is meant for (-14,
  the level the large streaming services normalise to); null for instruments.
- Vocals have no target.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.pipeline.eq_analysis import N_BANDS, NOMINAL_HZ

_PATH = Path(__file__).with_name("eq_targets.json")
MIX_USE = "mix"
BALANCED_VARIANT = "balanced"

# The target family each mixer lane uses.
LANE_USE = {
    "bass": "bass",
    "drums": "drums",
    "guitar": "guitar",
    "piano": "keys",
    "other": "other",
    "original": MIX_USE,
}


@dataclass(frozen=True)
class Target:
    id: str
    use: str
    variant: str
    label_key: str
    bands_db: tuple[float, ...]
    target_lufs: float | None

    def choice(self) -> dict:
        return {"id": self.id, "label_key": self.label_key}


def _target(entry: dict, bases: dict, variants: dict) -> Target:
    base, offset = bases[entry["use"]], variants[entry["variant"]]
    if len(base) != N_BANDS or len(offset) != N_BANDS:
        raise ValueError(f"eq_targets.json: {entry['id']} does not have {N_BANDS} bands")
    bands = tuple(round(float(b) + float(o), 2) for b, o in zip(base, offset, strict=True))
    return Target(
        id=entry["id"],
        use=entry["use"],
        variant=entry["variant"],
        label_key=entry["label_key"],
        bands_db=bands,
        target_lufs=entry["target_lufs"],
    )


@lru_cache(maxsize=1)
def load_targets() -> dict[str, Target]:
    data = json.loads(_PATH.read_text(encoding="utf-8"))
    if tuple(data["bands_hz"]) != tuple(NOMINAL_HZ):
        raise ValueError("eq_targets.json: band frequencies differ from the analysis")
    targets = (_target(t, data["bases"], data["variants"]) for t in data["targets"])
    return {t.id: t for t in targets}


def get_target(target_id: str) -> Target | None:
    return load_targets().get(target_id)


def targets_for_use(use: str) -> list[Target]:
    return [t for t in load_targets().values() if t.use == use]


def default_target(lane: str) -> Target | None:
    use = LANE_USE.get(lane)
    return get_target(f"{use}.{BALANCED_VARIANT}") if use else None
