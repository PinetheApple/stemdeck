// The lane space the recording tracks need, shared between the takes UI that
// sets it and player.js's lane fitting that reads it.

// Lanes may shrink this far so stems, recording tracks and + Track all fit.
export const TAKE_LANE_ROW_MIN_PX = 48;

let space = { lanes: 0, fixedPx: 0 };
let refit = null;

export function takeLaneSpace() {
  return space;
}

/** The smallest row the lanes may get: lower than the stems' own floor once + Track takes room. */
export function laneRowFloor(stemFloorPx) {
  return space.fixedPx > 0 ? Math.min(stemFloorPx, TAKE_LANE_ROW_MIN_PX) : stemFloorPx;
}

export function onTakeLayoutChange(fn) {
  refit = fn;
}

export function setTakeLaneSpace(next) {
  if (next.lanes === space.lanes && next.fixedPx === space.fixedPx) return;
  space = next;
  refit?.();
}
