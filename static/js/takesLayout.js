// The lane space the recording tracks need, shared between the takes UI that
// sets it and player.js's lane fitting that reads it.

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
