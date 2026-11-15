// Which EQ panel a lane gets. The kind follows from the lane name and is
// never stored: the bands in the lane's EQ are the truth for every panel.

const GRAPH = "graph";

/** Panel kinds. "graph" and "drum" are the same graphical editor. */
export const PANEL_KINDS = Object.freeze([GRAPH, "drum", "bass", "guitar", "keys"]);

const KIND_BY_LANE = new Map([
  ["drums", "drum"],
  ["bass", "bass"],
  ["guitar", "guitar"],
  ["piano", "keys"],
]);

const RESERVED_PREFIX = "__";

/** drums -> drum, bass/guitar -> their pedals, piano -> keys, anything else -> graph. */
export function panelKindFor(lane) {
  return KIND_BY_LANE.get(lane) || GRAPH;
}

/** Lane ids that get a lane panel (the master slot has its own place). */
export function laneHasPanel(lane) {
  return typeof lane === "string" && lane !== "" && !lane.startsWith(RESERVED_PREFIX);
}
