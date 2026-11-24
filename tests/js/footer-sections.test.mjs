// The footer's section line: which section is playing and which comes next.

import { sectionsAround } from '../../static/js/footerSections.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
}

const SECTIONS = [
  { id: 'a', start: 2, end: 10 },
  { id: 'b', start: 10, end: 20 },
  { id: 'c', start: 25, end: 30 },
];
const ids = ({ current, next }) => `${current?.id ?? '-'}${next?.id ?? '-'}`;

const CASES = [
  [0, '-a', 'before the first section only the next one is known'],
  [2, 'ab', 'a section starts at its own start'],
  [9.99, 'ab', 'the playing section and the one after it'],
  [10, 'bc', 'the next section takes over at its start'],
  [22, '-c', 'in a gap only the next section is known'],
  [27, 'c-', 'the last section has nothing after it'],
  [31, '--', 'after the last section there is nothing'],
];

for (const [sec, expected, name] of CASES) {
  const got = ids(sectionsAround(SECTIONS, sec));
  check(`${name} (${sec} s)`, got === expected, `got ${got}`);
}
check('no sections, nothing to show', ids(sectionsAround([], 5)) === '--');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
