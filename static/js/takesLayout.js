// The lane space the recording tracks need, shared between the takes UI that
// sets it and player.js's lane fitting that reads it.

// With recording rows, lanes may shrink this far so stems, tracks and + Track all fit.
export const TAKE_LANE_ROW_MIN_PX = 48;

let space = { lanes: 0, fixedPx: 0 };
let refit = null;

export function takeLaneSpace() {
  return space;
}

/** The smallest row the lanes may get: the stems' own floor unless the song has recording rows. */
export function laneRowFloor(stemFloorPx) {
  return space.lanes > 0 ? Math.min(stemFloorPx, TAKE_LANE_ROW_MIN_PX) : stemFloorPx;
}

export function onTakeLayoutChange(fn) {
  refit = fn;
}

export function setTakeLaneSpace(next) {
  if (next.lanes === space.lanes && next.fixedPx === space.fixedPx) return;
  space = next;
  refit?.();
}
