// The library's keyboard model (#46): which row or row button a key leads to,
// and where focus lands after the list is drawn again.
//
// Run:  node tests/js/roving-rows.test.mjs

import { ON_ROW, ROW_KEY, actionStep, landingIndex, rowStep } from '../../static/js/rovingRows.js';

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

const ROWS = 5;
const LAST = ROWS - 1;
const ACTIONS = 3;
const LAST_ACTION = ACTIONS - 1;

check('Down moves to the next row', rowStep(ROW_KEY.NEXT, 1, ROWS), 2);
check('Down stops at the last row', rowStep(ROW_KEY.NEXT, LAST, ROWS), LAST);
check('Up moves to the previous row', rowStep(ROW_KEY.PREVIOUS, 2, ROWS), 1);
check('Up stops at the first row', rowStep(ROW_KEY.PREVIOUS, 0, ROWS), 0);
check('Home goes to the first row', rowStep(ROW_KEY.FIRST, 3, ROWS), 0);
check('End goes to the last row', rowStep(ROW_KEY.LAST, 1, ROWS), LAST);
check('Up from a row that has gone lands on the first', rowStep(ROW_KEY.PREVIOUS, -1, ROWS), 0);
check('an empty list goes nowhere', rowStep(ROW_KEY.NEXT, 0, 0), null);
check('Enter is not a row movement', rowStep(ROW_KEY.OPEN, 1, ROWS), null);

check('Right from the row reaches its first button', actionStep(ROW_KEY.INTO, ON_ROW, ACTIONS), 0);
check('Right moves along the buttons', actionStep(ROW_KEY.INTO, 0, ACTIONS), 1);
check('Right stops at the last button', actionStep(ROW_KEY.INTO, LAST_ACTION, ACTIONS), null);
check('Right on a row without buttons stays', actionStep(ROW_KEY.INTO, ON_ROW, 0), null);
check('Left moves back along the buttons', actionStep(ROW_KEY.BACK, 1, ACTIONS), 0);
check('Left from the first button returns to the row', actionStep(ROW_KEY.BACK, 0, ACTIONS), ON_ROW);
check('Left on the row stays', actionStep(ROW_KEY.BACK, ON_ROW, ACTIONS), null);
check('Down is not a button movement', actionStep(ROW_KEY.NEXT, 0, ACTIONS), null);

const KEYS = ['a', 'b', 'c'];
check('a redraw keeps the same row', landingIndex(KEYS, { key: 'c', index: 0 }), 2);
check('a row that left gives way to the one now in its place', landingIndex(['a', 'c'], { key: 'b', index: 1 }), 1);
check('the last row leaving lands on the new last row', landingIndex(['a', 'b'], { key: 'c', index: 2 }), 1);
check('nothing remembered picks no row', landingIndex(KEYS, null), null);
check('an empty list picks no row', landingIndex([], { key: 'a', index: 0 }), null);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
