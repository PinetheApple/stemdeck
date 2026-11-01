// The beat grid drawn over the lanes while the click plays (static/js/beatgridShown.js).
// The e2e fixture is 6 seconds long, too short to ever need thinning.
//
// Run:  node tests/js/beatgrid-shown.test.mjs

import { clickLines, thinLines, SHOWN_MIN_PX } from '../../static/js/beatgridShown.js';

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

const BEATS_PER_BAR = 4;
const grid = (count, period = 0.5) => Array.from({ length: count }, (_, i) => i * period);
const onBar = (i) => i % BEATS_PER_BAR === 0;
const gaps = (lines) => lines.slice(1).map((line, i) => line.x - lines[i].x);
const evenlySpaced = (lines) => new Set(gaps(lines)).size <= 1;
const onlyBars = (lines) => lines.every((line) => line.bar);
// Beat `i` lands at i * pxPerBeat.
const placeAt = (pxPerBeat) => (t) => (t / 0.5) * pxPerBeat;

// ─── what the click plays ───

{
  const beats = grid(8);
  check('1x keeps every beat', clickLines(beats, onBar, 1).length === 8);
  const half = clickLines(beats, onBar, 0.5);
  check('half time keeps every other beat', half.map((l) => l.t).join() === '0,1,2,3');
  const double = clickLines(beats, onBar, 2);
  check('double time adds the midpoints', double.length === 15 && double[1].t === 0.25 && !double[1].bar);
  check('double time keeps the bar lines where they were', double.filter((l) => l.bar).map((l) => l.t).join() === '0,2');
}

// ─── thinning in musical steps ───

{
  const lines = clickLines(grid(64), onBar, 1);
  const all = thinLines(lines, placeAt(SHOWN_MIN_PX));
  check('beats far enough apart: every beat', all.length === 64 && evenlySpaced(all));

  const bars = thinLines(lines, placeAt(SHOWN_MIN_PX / 2));
  check('beats too close: bar lines only', bars.length === 16 && onlyBars(bars) && evenlySpaced(bars));

  const everyOther = thinLines(lines, placeAt(SHOWN_MIN_PX / 8));
  check('bars too close: every 2nd bar', everyOther.length === 8 && onlyBars(everyOther) && evenlySpaced(everyOther));

  const everyEighth = thinLines(lines, placeAt(SHOWN_MIN_PX / 32));
  check('far zoomed out: every 8th bar', everyEighth.length === 2 && everyEighth[1].t === 16, JSON.stringify(everyEighth));

  check(
    'no line closer than the minimum',
    [all, bars, everyOther, everyEighth].every((set) => gaps(set).every((g) => g >= SHOWN_MIN_PX)),
  );
}

{
  const lines = clickLines(grid(32), () => false, 1);
  const thinned = thinLines(lines, placeAt(SHOWN_MIN_PX / 3));
  check('no bar lines: beats thinned by powers of two', thinned.length === 8 && evenlySpaced(thinned));
}

check('every line on one pixel: still ends', thinLines(clickLines(grid(8), onBar, 1), () => 0).length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
