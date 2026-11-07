// Run:  node tests/js/accent-override.test.mjs

import {
  accentOverride, OVERRIDE_LENGTH, OVERRIDE_OFF, OVERRIDE_UNALIGNED,
} from '../../static/js/metronome.js';

const FOUR_FROM_ZERO = [{ beat: 0, beats_per_bar: 4 }];

const CASES = [
  { name: 'Off departs from the bars', mode: 0, bars: FOUR_FROM_ZERO, want: OVERRIDE_OFF },
  { name: 'an equal number from beat 0 matches', mode: 4, bars: FOUR_FROM_ZERO, want: null },
  { name: 'a different length departs', mode: 3, bars: FOUR_FROM_ZERO, want: OVERRIDE_LENGTH },
  { name: 'first mark on beat 1 is unaligned', mode: 4, bars: [{ beat: 1, beats_per_bar: 4 }], want: OVERRIDE_UNALIGNED },
  { name: 'first mark on beat 8 is unaligned: beats 0 and 4 have no line', mode: 4, bars: [{ beat: 8, beats_per_bar: 4 }], want: OVERRIDE_UNALIGNED },
  { name: 'mixed bars are unaligned', mode: 4, bars: [{ beat: 0, beats_per_bar: 4 }, { beat: 8, beats_per_bar: 3 }], want: OVERRIDE_UNALIGNED },
  { name: 'no bars leave nothing to depart from', mode: 4, bars: [], want: null },
];

let failed = 0;
for (const { name, mode, bars, want } of CASES) {
  const got = accentOverride(mode, bars);
  if (got !== want) failed++;
  console.log(`${got === want ? 'PASS' : 'FAIL'}  ${name}${got === want ? '' : `  -- got ${got}, want ${want}`}`);
}

console.log(`\n${CASES.length - failed}/${CASES.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
