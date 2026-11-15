"""The mix graph the master is measured on, built as the export renders it
(app/api/export_fx.py): each input through its lane chain (EQ, pitch shift,
gain), summed the way the render sums them (a take's limiter included), then
the master EQ, ending in the label ``[pre]`` that the master chain and the
meters read. The render builds its own graph from the same ``lane_chain``.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import TYPE_CHECKING

from app.api import takes_lanes

if TYPE_CHECKING:
    from app.api.export_fx import RenderFx, RenderLaneLike

PRE_LABEL = "[pre]"


def lane_chain(eq: str, pitch: str, gain: float, delay: str = "") -> str:
    """One input's chain as both the render and the measurement run it:
    EQ, pitch shift, the count-in delay (render only), gain."""
    return f"{eq}{pitch}{delay}volume={gain:.6f}"


def measurement_graph(
    lane_chains: list[str],
    names: list[str],
    master_eq: str,
    click_level: str | None = None,
) -> str:
    """Input i through ``lane_chains[i]`` and the click (when given) summed as
    the render sums them, take limiter included, then the master EQ, to [pre]."""
    filters = [f"[{i}:a]{chain}[a{i}]" for i, chain in enumerate(lane_chains)]
    if click_level is not None:
        filters.append(f"[{len(filters)}:a]{click_level}[a{len(filters)}]")
    label = takes_lanes.sum_lanes(filters, len(filters), names)
    return ";".join([*filters, f"{label}{master_eq}anull{PRE_LABEL}"])


def lanes_graph(
    lanes: Sequence[RenderLaneLike],
    render_fx: RenderFx,
    pitch_filter: Callable[[int], str],
    master_eq: str,
    click_level: str | None = None,
) -> str:
    """``measurement_graph`` for ``lanes``, each through its ``lane_chain``."""
    chains = [
        lane_chain(render_fx.prefix(i), pitch_filter(lane.pitch), lane.gain)
        for i, lane in enumerate(lanes)
    ]
    return measurement_graph(chains, [lane.name for lane in lanes], master_eq, click_level)
