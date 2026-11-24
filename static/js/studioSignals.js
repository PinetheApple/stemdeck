// Playhead and loop changes, published by transport.js for studio views it cannot import without a cycle.

const playheadListeners = new Set();
const loopListeners = new Set();

export function onPlayheadMove(listener) {
  playheadListeners.add(listener);
}

export function emitPlayheadMove(sec) {
  playheadListeners.forEach((listener) => listener(sec));
}

export function onLoopChange(listener) {
  loopListeners.add(listener);
}

export function emitLoopChange() {
  loopListeners.forEach((listener) => listener());
}
