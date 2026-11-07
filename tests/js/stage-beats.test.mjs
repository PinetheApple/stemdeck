// The e2e fixture is a six-second 4/4 song, too short to reach a far first mark.
// Run:  node tests/js/stage-beats.test.mjs

import { buildBeatTable, beatAt } from '../../static/js/stageBeats.js';

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

const PERIOD = 0.5;
const FALLBACK = 3;
const grid = (count, start = 0) => Array.from({ length: count }, (_, i) => start + i * PERIOD);
const noMarks = () => null;

// The same lookup as beatgrid.js barPositionIndex, over marks given here.
const marks = (bars) => (i) => {
  const mark = bars.findLast((b) => b.beat <= i);
  return mark ? [(i - mark.beat) % mark.beats_per_bar, mark.beats_per_bar] : null;
};
const counts = (table) => table.map(({ bar, beat, length }) => `${bar}.${beat}/${length}`);

{
  const table = buildBeatTable(grid(8), marks([{ beat: 5, beats_per_bar: 4 }]), FALLBACK);
  check(
    'before the first mark, the mark\'s bar runs backwards, in phase with its downbeats',
    counts(table),
    ['1.4/4', '2.1/4', '2.2/4', '2.3/4', '2.4/4', '3.1/4', '3.2/4', '3.3/4'],
  );
}
{
  const table = buildBeatTable(grid(400), marks([{ beat: 157, beats_per_bar: 4 }, { beat: 367, beats_per_bar: 2 }]), FALLBACK);
  check('a first mark far into the song: beat 0 is already counting', counts(table)[0], '1.4/4');
  check('a first mark far into the song: its own beat is a downbeat', table[157].beat, 1);
  check('a first mark far into the song: the beat before it ends a bar', table[156].beat, 4);
  check('the last beat before a far mark changes the bar length', counts(table)[366], '93.2/4');
  check('a far mark starts a bar of its own length', counts(table)[367], '94.1/2');
}

{
  const table = buildBeatTable(grid(8), marks([{ beat: 0, beats_per_bar: 4 }, { beat: 4, beats_per_bar: 2 }]), FALLBACK);
  check(
    'a 2-beat stretch counts in 2s and carries its own length',
    counts(table),
    ['1.1/4', '1.2/4', '1.3/4', '1.4/4', '2.1/2', '2.2/2', '3.1/2', '3.2/2'],
  );
}
{
  const table = buildBeatTable(grid(5), marks([{ beat: 0, beats_per_bar: 4 }, { beat: 2, beats_per_bar: 3 }]), FALLBACK);
  check('a mark that cuts a bar short starts a new bar', counts(table), ['1.1/4', '1.2/4', '2.1/3', '2.2/3', '2.3/3']);
}

check(
  'empty bars count from the first beat at the fallback length',
  counts(buildBeatTable(grid(4), noMarks, FALLBACK)),
  ['1.1/3', '1.2/3', '1.3/3', '2.1/3'],
);

{
  const table = buildBeatTable(grid(4, 1), marks([{ beat: 0, beats_per_bar: 4 }]), FALLBACK);
  check('before the first beat there is no entry', beatAt(table, 0.99), null);
  check('on a beat, that beat', beatAt(table, 1.5).beat, 2);
  check('between beats, the one in force', beatAt(table, 1.99).beat, 2);
  check('after the last beat, the last beat', beatAt(table, 99).beat, 4);
}

{
  const table = buildBeatTable([], noMarks, FALLBACK);
  check('no grid builds an empty table', table, []);
  check('no grid has no entry at any time', beatAt(table, 1), null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
