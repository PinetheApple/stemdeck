// Run:  node tests/js/inspector-tab-fit.test.mjs
//
// Which song-tool tabs move into More when the panel is too narrow for all of them.

import assert from "node:assert/strict";

const { overflowTabs } = await import("../../static/js/inspectorTabFit.js");

const WIDTHS = [60, 90, 60, 40, 60];
const GAP = 2;
const MORE = 70;
const ALL_FIT = 400;
const TIGHT = 230;
const VERY_TIGHT = 140;
const LAST = WIDTHS.length - 1;

const fit = (room, open = 0, widths = WIDTHS) => overflowTabs({ widths, open, room, moreWidth: MORE, gap: GAP });

assert.deepEqual(fit(ALL_FIT), [], "every tab fits: nothing goes into More");

const exact = WIDTHS.reduce((sum, w) => sum + w, 0) + GAP * (WIDTHS.length - 1);
assert.deepEqual(fit(exact), [], "tabs that fit to the pixel stay out");
assert.ok(fit(exact - 1).length > 0, "one pixel short: More appears");

const tight = fit(TIGHT);
assert.ok(tight.length > 0, "a tight panel puts some tabs in More");
assert.ok(!tight.includes(0), "the open tab is never in More");

for (let open = 0; open <= LAST; open += 1) {
  assert.ok(!fit(VERY_TIGHT, open).includes(open), `open tab ${open} stays out of More`);
}
assert.deepEqual(
  fit(VERY_TIGHT, LAST),
  [0, 1, 2, 3],
  "with room only for the open tab and More, every other tab goes in",
);

for (let room = VERY_TIGHT; room < exact; room += 1) {
  const out = fit(room);
  const shown = WIDTHS.filter((_, i) => !out.includes(i));
  assert.ok(MORE + shown.reduce((sum, w) => sum + w + GAP, 0) <= room, `at ${room} px the shown tabs and More fit`);
}

console.log("inspector-tab-fit: ok");
