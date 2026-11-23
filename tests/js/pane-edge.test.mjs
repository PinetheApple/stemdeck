// Run:  node tests/js/pane-edge.test.mjs
//
// The width a dragged pane edge settles on, for each of the three edges.

import assert from "node:assert/strict";

const { PANE_LIMITS, clampPaneWidth } = await import("../../static/js/paneEdgeMath.js");

const PLENTY_OF_ROOM = 1000;
const ROOM_FOR_40_MORE = 40;
const NO_ROOM = -100;
const OVERSHOOT = 400;
const FRACTION = 0.6;

function casesFor({ min, max }) {
  const current = min + 8;
  const inside = Math.round((min + max) / 2);
  return [
    ["inside its limits, a width is kept", { px: inside, current, spare: PLENTY_OF_ROOM }, inside],
    ["below the minimum, the minimum", { px: min - OVERSHOOT, current, spare: PLENTY_OF_ROOM }, min],
    ["above the maximum, the maximum", { px: max + OVERSHOOT, current, spare: PLENTY_OF_ROOM }, max],
    ["it grows only by what the waveforms can spare", { px: max, current, spare: ROOM_FOR_40_MORE }, current + ROOM_FOR_40_MORE],
    ["squeezed waveforms pull it back, never under the minimum", { px: inside, current, spare: NO_ROOM }, min],
    ["a fraction of room left is not taken from the waveforms", { px: max, current, spare: ROOM_FOR_40_MORE + FRACTION }, current + ROOM_FOR_40_MORE],
    ["a chosen fraction rounds to whole pixels", { px: inside + FRACTION, current, spare: PLENTY_OF_ROOM }, inside + 1],
  ];
}

let count = 0;
for (const [edge, limits] of Object.entries(PANE_LIMITS)) {
  for (const [name, { px, current, spare }, expected] of casesFor(limits)) {
    assert.equal(clampPaneWidth(px, { ...limits, current, spare }), expected, `${edge}: ${name}`);
    count++;
  }
}
console.log(`pane-edge: ${count} cases passed`);
