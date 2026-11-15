// How much of the lane stack the recording tracks need, for the lane fitting
// in player.js: whole lanes for the tracks, short rows for open take folders
// and the add row. player.js registers its refit; the takes UI sets the space.

let space = { lanes: 0, fixedPx: 0 };
let refit = null;

export function takeLaneSpace() {
  return space;
}

export function onTakeLayoutChange(fn) {
  refit = fn;
}

export function setTakeLaneSpace(next) {
  if (next.lanes === space.lanes && next.fixedPx === space.fixedPx) return;
  space = next;
  refit?.();
}
