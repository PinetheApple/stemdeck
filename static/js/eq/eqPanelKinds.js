// The kind follows from the lane name and is never stored: the lane's bands
// are the truth for every panel, so switching kinds loses nothing.

export const PANEL_KIND = Object.freeze({
  graph: "graph",
  drum: "drum",
  bass: "bass",
  guitar: "guitar",
  keys: "keys",
});

/** Panel kinds. "graph" and "drum" are the same graphical editor. */
export const PANEL_KINDS = Object.freeze(Object.values(PANEL_KIND));

const KIND_BY_LANE = new Map([
  ["drums", PANEL_KIND.drum],
  ["bass", PANEL_KIND.bass],
  ["guitar", PANEL_KIND.guitar],
  ["piano", PANEL_KIND.keys],
]);

const RESERVED_PREFIX = "__";

/** drums -> drum, bass/guitar -> their pedals, piano -> keys, anything else -> graph. */
export function panelKindFor(lane) {
  return KIND_BY_LANE.get(lane) || PANEL_KIND.graph;
}

/** Lane ids that get a lane panel (the master slot has its own place). */
export function laneHasPanel(lane) {
  return typeof lane === "string" && lane !== "" && !lane.startsWith(RESERVED_PREFIX);
}
