// Stage mode's song overview: where each section sits on the whole-song strip.
// Run:  node tests/js/stage-mix.test.mjs

import { sectionSpans } from '../../static/js/stageModel.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  if (got === want) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- got ${got}, want ${want}`);
  }
}

check(
  'sections sit at their share of the song',
  sectionSpans([{ start: 0, end: 3, name: 'A' }, { start: 3, end: 6, name: 'B' }], 6),
  [{ start: 0, name: 'A', left: 0, width: 50 }, { start: 3, name: 'B', left: 50, width: 50 }],
);
check(
  'a section without an end runs to the next one, the last to the end of the song',
  sectionSpans([{ start: 0, name: 'A' }, { start: 2, name: 'B' }], 8),
  [{ start: 0, name: 'A', left: 0, width: 25 }, { start: 2, name: 'B', left: 25, width: 75 }],
);
check(
  'a section past the end of the song is clipped to it',
  sectionSpans([{ start: 4, end: 12, name: 'A' }], 8),
  [{ start: 4, name: 'A', left: 50, width: 50 }],
);
check('no duration yet, no spans', sectionSpans([{ start: 0, end: 3, name: 'A' }], 0), []);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
