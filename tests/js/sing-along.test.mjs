// Sing along in Stage: which vocals stay quiet, how far each word is sung, which
// lines are on screen, and the song-end countdown.
// Run:  node tests/js/sing-along.test.mjs

import {
  countdownState,
  lyricWindow,
  silencedVocals,
  singStoreKey,
  vocalSplit,
  voiceOnFrom,
  wordProgress,
} from '../../static/js/stageSingModel.js';

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

const SPLIT_PAIR = ['lead_vocals', 'backing_vocals'];
const JOB = 'abc123';

{
  check('the voice key sits beside the mix key', singStoreKey(JOB), 'stemdeck:singalong:abc123');
  check('nothing stored means voice off', voiceOnFrom(null), false);
  check('a stored off stays off', voiceOnFrom({ voice: false }), false);
  check('a stored on is on', voiceOnFrom({ voice: true }), true);
  check('anything else is off', voiceOnFrom({ voice: 'yes' }), false);
}
{
  check('both split stems loaded is a split', vocalSplit(['drums', ...SPLIT_PAIR], SPLIT_PAIR), true);
  check('one split stem is no split', vocalSplit(['vocals', 'lead_vocals'], SPLIT_PAIR), false);
  check('plain vocals is no split', vocalSplit(['vocals', 'drums'], SPLIT_PAIR), false);
}
{
  const plain = { split: false, backingOn: true };
  check('no split, voice off silences all vocals', silencedVocals({ ...plain, voiceOn: false }, SPLIT_PAIR), ['vocals']);
  check('no split, voice on silences nothing', silencedVocals({ ...plain, voiceOn: true }, SPLIT_PAIR), []);
  const split = { split: true };
  check(
    'split, voice off and backing on silences the lead only',
    silencedVocals({ ...split, voiceOn: false, backingOn: true }, SPLIT_PAIR),
    ['lead_vocals'],
  );
  check(
    'split, both off silences lead and backing',
    silencedVocals({ ...split, voiceOn: false, backingOn: false }, SPLIT_PAIR),
    SPLIT_PAIR,
  );
  check(
    'split, voice on and backing off silences the backing only',
    silencedVocals({ ...split, voiceOn: true, backingOn: false }, SPLIT_PAIR),
    ['backing_vocals'],
  );
  check('split, both on silences nothing', silencedVocals({ ...split, voiceOn: true, backingOn: true }, SPLIT_PAIR), []);
}
{
  const words = [
    { text: 'I ', start: 1, end: 2 },
    { text: 'walked ', start: 2, end: 4 },
    { text: 'home', start: 4, end: 5 },
  ];
  const states = (time) => wordProgress(words, time).map(({ state, fill }) => `${state}:${fill}`);
  check('before the line nothing is sung', states(0.5), ['todo:0', 'todo:0', 'todo:0']);
  check('mid-word fills that word part way', states(3), ['sung:100', 'singing:50', 'todo:0']);
  check('a word is sung once its end is reached', states(4), ['sung:100', 'sung:100', 'todo:0']);
  check('after the line every word is sung', states(9), ['sung:100', 'sung:100', 'sung:100']);
}
{
  const lines = [
    { time: 0, text: '' },
    { time: 6, text: 'First sung' },
    { time: 9, text: 'Second' },
    { time: 12, text: '' },
    { time: 14, text: 'Third' },
  ];
  check('before the first sung line it counts down to it', lyricWindow(lines, 1.5), { intro: 4.5, now: 1 });
  check('on a line it is the current one', lyricWindow(lines, 10), { intro: null, now: 2 });
  check('an instrumental gap after singing is current', lyricWindow(lines, 13), { intro: null, now: 3 });
  check('no sung line gives no window', lyricWindow([{ time: 0, text: ' ' }], 3), null);
  check('no lines gives no window', lyricWindow([], 3), null);
}
{
  const TOTAL_MS = 5000;
  check('the countdown starts full', countdownState(0, TOTAL_MS), { left: 5, share: 1, done: false });
  check('part way it rounds the seconds up', countdownState(1200, TOTAL_MS), { left: 4, share: 0.76, done: false });
  check('at the end it is done', countdownState(TOTAL_MS, TOTAL_MS), { left: 0, share: 0, done: true });
  check('past the end it stays done', countdownState(TOTAL_MS + 900, TOTAL_MS), { left: 0, share: 0, done: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
