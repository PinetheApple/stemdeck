// The styled select list's keyboard, type-ahead and placement decisions.
//
// Run:  node tests/js/select-menu.test.mjs

import { edgeIndex, placeList, stepIndex, typeaheadIndex } from '../../static/js/selectMenuLogic.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  if (Object.is(actual, expected)) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- expected ${expected}, got ${actual}`);
  }
}

const NONE = [false, false, false, false];
const MIDDLE_OFF = [false, false, true, false];
const ENDS_OFF = [true, false, false, true];
const ALL_OFF = [true, true];

check('Home lands on the first option', edgeIndex(NONE, false), 0);
check('End lands on the last option', edgeIndex(NONE, true), 3);
check('Home skips a disabled first option', edgeIndex(ENDS_OFF, false), 1);
check('End skips a disabled last option', edgeIndex(ENDS_OFF, true), 2);
check('a list with nothing enabled has no edge', edgeIndex(ALL_OFF, false), -1);

check('Down moves to the next option', stepIndex(NONE, 0, 1), 1);
check('Down skips a disabled option', stepIndex(MIDDLE_OFF, 1, 1), 3);
check('Up skips a disabled option', stepIndex(MIDDLE_OFF, 3, -1), 1);
check('Down stays on the last option', stepIndex(NONE, 3, 1), 3);
check('Up stays on the first option', stepIndex(NONE, 0, -1), 0);
check('Down stays put when only disabled options follow', stepIndex(ENDS_OFF, 2, 1), 2);
check('Down with nothing chosen lands on the first enabled', stepIndex(ENDS_OFF, -1, 1), 1);
check('Up with nothing chosen lands on the last enabled', stepIndex(ENDS_OFF, -1, -1), 2);

const DEVICES = ['Auto', 'CUDA (NVIDIA)', 'MPS (Apple Silicon) — not available', 'CPU'];
const DEVICES_OFF = [false, false, true, false];

check('a letter picks the first match', typeaheadIndex(DEVICES, DEVICES_OFF, 'c', 0), 1);
check('the same letter again cycles to the next match', typeaheadIndex(DEVICES, DEVICES_OFF, 'cc', 1), 3);
check('cycling wraps back to the top', typeaheadIndex(DEVICES, DEVICES_OFF, 'c', 3), 1);
check('more letters narrow the match', typeaheadIndex(DEVICES, DEVICES_OFF, 'cp', 0), 3);
check('a longer prefix keeps the current match', typeaheadIndex(DEVICES, DEVICES_OFF, 'cu', 1), 1);
check('matching ignores case', typeaheadIndex(DEVICES, DEVICES_OFF, 'A', -1), 0);
check('a disabled option is never matched', typeaheadIndex(DEVICES, DEVICES_OFF, 'm', 0), -1);
check('no match finds nothing', typeaheadIndex(DEVICES, DEVICES_OFF, 'z', 0), -1);
check('nothing typed finds nothing', typeaheadIndex(DEVICES, DEVICES_OFF, '', 0), -1);

const LANGUAGES = ['🇬🇧 English', '🇪🇸 Español', '🇩🇪 Deutsch'];
check('a leading flag is skipped', typeaheadIndex(LANGUAGES, [false, false, false], 'd', 0), 2);

const VIEWPORT = { width: 1000, height: 800 };
const PLACE = { listWidth: 200, viewport: VIEWPORT, gap: 4, margin: 8 };
const ANCHOR_TOP = { top: 100, bottom: 130, left: 300 };
const ANCHOR_LOW = { top: 700, bottom: 730, left: 300 };

const roomy = placeList({ ...PLACE, anchor: ANCHOR_TOP, listHeight: 300 });
check('a list that fits opens below', roomy.flipped, false);
check('below sits one gap under the select', roomy.top, 134);
check('below is capped to the room under the select', roomy.maxHeight, 658);

const low = placeList({ ...PLACE, anchor: ANCHOR_LOW, listHeight: 300 });
check('near the bottom edge the list flips upward', low.flipped, true);
check('flipped, its bottom sits one gap above the select', low.top + 300, 696);
check('flipped, it is capped to the room above', low.maxHeight, 688);

const tall = placeList({ ...PLACE, anchor: ANCHOR_LOW, listHeight: 2000 });
check('a list taller than the room above starts at the margin', tall.top, 8);

const shortBelow = placeList({ ...PLACE, anchor: { top: 60, bottom: 700, left: 300 }, listHeight: 300 });
check('it stays below when there is more room there', shortBelow.flipped, false);

const right = placeList({ ...PLACE, anchor: { ...ANCHOR_TOP, left: 950 }, listHeight: 100 });
check('it is pulled left to stay inside the viewport', right.left, 792);
const left = placeList({ ...PLACE, anchor: { ...ANCHOR_TOP, left: -40 }, listHeight: 100 });
check('it never starts left of the margin', left.left, 8);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
