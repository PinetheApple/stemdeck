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
} from '../../static/js/stageSingModel.js';
import { wordFill } from '../../static/js/lyricsLookup.js';

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
  const quiet = (state, loaded) => silencedVocals(state, loaded, SPLIT_PAIR);
  const plain = { split: false, backingOn: true };
  const plainLoad = ['vocals', 'drums'];
  check('no split, voice off silences the vocals', quiet({ ...plain, voiceOn: false }, plainLoad), ['vocals']);
  check('no split, voice on silences nothing', quiet({ ...plain, voiceOn: true }, plainLoad), []);
  check(
    'half a split, voice off silences every loaded vocal',
    quiet({ ...plain, voiceOn: false }, ['vocals', 'lead_vocals', 'drums']),
    ['vocals', 'lead_vocals'],
  );
  check(
    'half a split without plain vocals, voice off silences the half that is loaded',
    quiet({ ...plain, voiceOn: false }, ['backing_vocals', 'drums']),
    ['backing_vocals'],
  );
  const splitLoad = ['drums', ...SPLIT_PAIR];
  const splitQuiet = (voiceOn, backingOn) => quiet({ split: true, voiceOn, backingOn }, splitLoad);
  check('split, voice off and backing on silences the lead only', splitQuiet(false, true), ['lead_vocals']);
  check('split, both off silences lead and backing', splitQuiet(false, false), SPLIT_PAIR);
  check('split, voice on and backing off silences the backing', splitQuiet(true, false), ['backing_vocals']);
  check('split, both on silences nothing', splitQuiet(true, true), []);
}
{
  const words = [
    { text: 'I ', start: 1, end: 2 },
    { text: 'walked ', start: 2, end: 4 },
    { text: 'home', start: 4, end: 5 },
  ];
  const fills = (time) => words.map((word) => {
    const { sung, singing, fill } = wordFill(word, time);
    return `${sung ? 'sung' : singing ? 'singing' : 'todo'}:${fill}`;
  });
  check('before the line nothing is sung', fills(0.5), ['todo:0', 'todo:0', 'todo:0']);
  check('mid-word fills that word part way', fills(3), ['sung:100', 'singing:50', 'todo:0']);
  check('a word is sung once its end is reached', fills(4), ['sung:100', 'sung:100', 'todo:0']);
  check('after the line every word is sung', fills(9), ['sung:100', 'sung:100', 'sung:100']);
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
