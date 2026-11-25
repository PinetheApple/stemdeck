// The kind follows from the lane name and is never stored.

export const PANEL_KIND = Object.freeze({
  graph: "graph",
  drum: "drum",
});

/** Panel kinds. Both are the same graphical editor; only the title differs. */
export const PANEL_KINDS = Object.freeze(Object.values(PANEL_KIND));

const KIND_BY_LANE = new Map([["drums", PANEL_KIND.drum]]);

const RESERVED_PREFIX = "__";

/** drums -> drum, anything else -> graph. */
export function panelKindFor(lane) {
  return KIND_BY_LANE.get(lane) || PANEL_KIND.graph;
}

/** Lane ids that get a lane panel (the master slot has its own place). */
export function laneHasPanel(lane) {
  return typeof lane === "string" && lane !== "" && !lane.startsWith(RESERVED_PREFIX);
}
