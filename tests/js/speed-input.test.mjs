// The speed box and the wheel: what a typed speed means, and where the next notch is.

import { clampSpeed, nextNotch, parseSpeedInput } from '../../static/js/speedInput.js';

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

const TYPED = [
  ['0.83', 0.83],
  ['0,83', 0.83],
  ['0.83x', 0.83],
  ['0.83X', 0.83],
  [' 0.83 x ', 0.83],
  ['83', 0.83],
  ['83%', 0.83],
  ['83 %', 0.83],
  ['.9', 0.9],
  ['1', 1],
  ['1x', 1],
  ['100%', 1],
  ['0.834', 0.83],
  ['0.2', 0.5],
  ['20%', 0.5],
  ['1.5', 1],
  ['150', 1],
];

for (const [text, expected] of TYPED) {
  const got = parseSpeedInput(text);
  check(`"${text}" reads as ${expected}x`, got === expected, `got ${got}`);
}

for (const text of ['', '  ', 'abc', 'x', '%', '0.8.3', '-0.8', '0x1a', 'Infinity', '1e2', 'fast']) {
  const got = parseSpeedInput(text);
  check(`"${text}" is not a speed`, got === null, `got ${got}`);
}

check('clamps below the floor', clampSpeed(0.3) === 0.5);
check('clamps above 1x', clampSpeed(1.2) === 1);
check('rounds to a hundredth', clampSpeed(0.876) === 0.88);

const NOTCHES = [
  [1, -1, 0.95],
  [0.95, -1, 0.9],
  [0.83, 1, 0.85],
  [0.83, -1, 0.8],
  [0.85, 1, 0.9],
  [0.85, -1, 0.8],
  [0.5, -1, 0.5],
  [1, 1, 1],
];

for (const [from, direction, expected] of NOTCHES) {
  const got = nextNotch(from, direction);
  check(`from ${from} ${direction > 0 ? 'up' : 'down'} is ${expected}`, got === expected, `got ${got}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
