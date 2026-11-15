// Stage mode's mixer and song-overview maths: which strips show, which are silent, where sections sit.
// Run:  node tests/js/stage-mix.test.mjs

import { loadedStems, isInaudible, sectionSpans, gainDbText } from '../../static/js/stageModel.js';

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

const entry = (muted = false, soloed = false) => ({ volume: 1, muted, soloed, pitch: 0 });

check(
  'strips follow the loaded lanes in lane order, without the original',
  loadedStems({ original: 0, drums: 2, bass: 1, other: 3 }, ['original', 'drums', 'bass', 'other']),
  ['bass', 'drums', 'other'],
);
check(
  'a lane kept for a stem the song lacks gets no strip',
  loadedStems({ vocals: 0, drums: 1, guitar: 2, piano: 3 }, ['vocals', 'drums']),
  ['vocals', 'drums'],
);
check(
  'a vocal split shows lead and backing, no vocals',
  loadedStems({ drums: 0, lead_vocals: 1, backing_vocals: 2 }, ['vocals', 'drums', 'lead_vocals', 'backing_vocals']),
  ['drums', 'lead_vocals', 'backing_vocals'],
);
check('nothing loaded, no strips', loadedStems({}, []), []);

const index = { original: 0, drums: 1, bass: 2 };
check('a plain lane is audible', isInaudible('drums', { drums: entry(), bass: entry() }, index), false);
check('a muted lane is silent', isInaudible('drums', { drums: entry(true), bass: entry() }, index), true);
check('another lane soloed silences this one', isInaudible('drums', { drums: entry(), bass: entry(false, true) }, index), true);
check('a soloed lane is audible', isInaudible('bass', { drums: entry(), bass: entry(false, true) }, index), false);
check('muted beats soloed', isInaudible('bass', { drums: entry(), bass: entry(true, true) }, index), true);
check(
  'a solo on a lane this song lacks silences nothing',
  isInaudible('drums', { drums: entry(), bass: entry(), piano: entry(false, true) }, index),
  false,
);

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

check('unity reads 0.0', gainDbText(1), '0.0');
check('double reads +6.0', gainDbText(2), '+6.0');
check('half reads -6.0', gainDbText(0.5), '-6.0');
check('silence reads -∞', gainDbText(0), '-∞');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
