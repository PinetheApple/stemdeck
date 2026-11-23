// Run:  node tests/js/pane-edge.test.mjs
//
// The width a dragged pane edge settles on: inside its own limits, and never so
// wide that the waveforms beside it drop under their minimum.

import assert from "node:assert/strict";

const { clampPaneWidth } = await import("../../static/js/paneEdgeMath.js");

const LIMITS = { min: 232, max: 380 };
const CURRENT = 260;
const PLENTY_OF_ROOM = 1000;
const ROOM_FOR_40_MORE = 40;
const NO_ROOM = -100;

const cases = [
  ["inside its limits, a width is kept", { px: 300, spare: PLENTY_OF_ROOM }, 300],
  ["below the minimum, the minimum", { px: 100, spare: PLENTY_OF_ROOM }, LIMITS.min],
  ["above the maximum, the maximum", { px: 900, spare: PLENTY_OF_ROOM }, LIMITS.max],
  ["it grows only by what the waveforms can spare", { px: 360, spare: ROOM_FOR_40_MORE }, CURRENT + ROOM_FOR_40_MORE],
  ["squeezed waveforms pull it back, never under the minimum", { px: 300, spare: NO_ROOM }, LIMITS.min],
  ["a fraction rounds to whole pixels", { px: 300.6, spare: PLENTY_OF_ROOM }, 301],
];

for (const [name, { px, spare }, expected] of cases) {
  assert.equal(clampPaneWidth(px, { ...LIMITS, current: CURRENT, spare }), expected, name);
}
console.log(`pane-edge: ${cases.length} cases passed`);
