// Play history and the order Previous and Next pick songs in: a browser-like
// back/forward list, the 3-second restart, and what follows in a list.
//
// Run:  node tests/js/play-history.test.mjs

import { BACK, FORWARD, createStepHistory } from '../../static/js/stepHistory.js';
import {
  NEXT_SOURCE,
  RESTART_AFTER_SEC,
  cursorAt,
  nextSong,
  previousPlayedId,
  previousSongId,
  songsAhead,
} from '../../static/js/playOrder.js';

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) passed++;
  else failed++;
  console.log(`${same ? 'PASS' : 'FAIL'}  ${name}${same ? '' : `  -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

const anySong = () => true;
const except = (...gone) => (id) => !gone.includes(id);

function visited(...ids) {
  const history = createStepHistory();
  ids.forEach((id) => history.visit(id));
  return history;
}

{
  const history = visited('a', 'b', 'c');
  check('nothing ahead of the newest song', history.peek(FORWARD, anySong), null);
  check('back peeks at the song before', history.peek(BACK, anySong), 'b');
  check('back steps to the song before', history.go(BACK, anySong), 'b');
  check('the place is then that song', history.current(), 'b');
  check('forward steps again to the song stepped back from', history.go(FORWARD, anySong), 'c');
}

{
  const history = visited('a', 'b', 'c');
  history.go(BACK, anySong);
  history.go(BACK, anySong);
  history.visit('d');
  check('a song opened after stepping back drops what was ahead', history.peek(FORWARD, anySong), null);
  check('and follows the song it was opened from', history.peek(BACK, anySong), 'a');
}

{
  const history = visited('a', 'b');
  history.visit('b');
  check('the same song twice in a row is kept once', history.go(BACK, anySong), 'a');
  check('nothing before the first song', history.go(BACK, anySong), null);
}

{
  const history = visited('a', 'b', 'c');
  check('back skips a song that cannot play', history.go(BACK, except('b')), 'a');
  check('forward skips it too', history.go(FORWARD, except('b')), 'c');
  check('with only unplayable songs behind, there is no song before', visited('a', 'b').peek(BACK, except('a')), null);
}

{
  const history = visited('a', 'b');
  history.go(BACK, anySong);
  history.visit('a');
  check('visiting the song stepped to keeps what is ahead', history.peek(FORWARD, anySong), 'b');
}

{
  const history = visited('a', 'c');
  const back = previousPlayedId(history, 'c', anySong);
  check('within 3 s Previous goes to the song played before the playing one', previousSongId(RESTART_AFTER_SEC, back), 'a');
}

check('from an open song that was not the last played, Previous goes to the last played', previousPlayedId(visited('a'), 'b', anySong), 'a');

check('Previous restarts a song played for more than 3 seconds', previousSongId(RESTART_AFTER_SEC + 0.1, 'a'), null);
check('Previous goes to the song before within 3 seconds', previousSongId(RESTART_AFTER_SEC, 'a'), 'a');
check('Previous restarts when there is no song before', previousSongId(0, null), null);

check('Next goes forward through history first', nextSong({ forwardId: 'f', upNextId: 'u', listId: 'l' }), { source: NEXT_SOURCE.HISTORY, id: 'f' });
check('then plays the first song in Up Next', nextSong({ forwardId: null, upNextId: 'u', listId: 'l' }), { source: NEXT_SOURCE.UP_NEXT, id: 'u' });
check('then the next song of the list', nextSong({ forwardId: null, upNextId: null, listId: 'l' }), { source: NEXT_SOURCE.LIST, id: 'l' });
check('with none of them there is no next song', nextSong({ forwardId: null, upNextId: null, listId: null }), null);

const list = { ids: ['a', 'b', 'c', 'd'], at: 1 };
check('the list ahead is what follows the cursor', songsAhead(list, anySong), ['c', 'd']);
check('it leaves out songs that cannot play or are queued', songsAhead(list, except('c')), ['d']);
check('a list not started yet has every song ahead', songsAhead({ ids: ['a', 'b'], at: -1 }, anySong), ['a', 'b']);
check('the cursor moves to a song of the list', cursorAt(list, 'd'), 3);
check('a song from elsewhere leaves the cursor', cursorAt(list, 'x'), 1);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
