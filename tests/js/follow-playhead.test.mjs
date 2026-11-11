// Auto-scroll's page-turn and pause decisions (static/js/followPlayhead.js).
//
// Run:  node tests/js/follow-playhead.test.mjs

import {
  pageTurnTarget, isBackwardJump, isManualScroll, followStep,
  TURN_AT, LAND_AT, BACKWARD_JUMP_SEC,
} from '../../static/js/followPlayhead.js';

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

const VIEWPORT = 1000;
const CONTENT = 10000;
const view = (scrollLeft, playheadX) => ({
  scrollLeft, viewportWidth: VIEWPORT, contentWidth: CONTENT, playheadX,
});

// ─── Page turns ───

check('steady while the playhead crosses the page',
  [0, 300, 600, VIEWPORT * TURN_AT].every((x) => pageTurnTarget(view(0, x)) === null));
check('turns once the playhead passes the edge zone',
  pageTurnTarget(view(0, VIEWPORT * TURN_AT + 1)) === VIEWPORT * TURN_AT + 1 - VIEWPORT * LAND_AT);
check('after a turn the playhead sits near the left and the view holds',
  pageTurnTarget(view(pageTurnTarget(view(0, 950)), 960)) === null);
check('a playhead off to the left (seek back) is brought into view',
  pageTurnTarget(view(5000, 1200)) === 1200 - VIEWPORT * LAND_AT);
check('a playhead far to the right (seek ahead) is brought into view',
  pageTurnTarget(view(0, 7000)) === 7000 - VIEWPORT * LAND_AT);
check('never scrolls before the start',
  pageTurnTarget(view(3000, 50)) === 0);
check('never scrolls past the end',
  pageTurnTarget(view(8000, 9990)) === CONTENT - VIEWPORT);
check('at the end of the track the view stays put',
  pageTurnTarget(view(CONTENT - VIEWPORT, 9990)) === null);
check('nothing to do when the whole track fits',
  pageTurnTarget({ scrollLeft: 0, viewportWidth: 1000, contentWidth: 1000, playheadX: 990 }) === null);
check('nothing to do before layout',
  pageTurnTarget({ scrollLeft: 0, viewportWidth: 0, contentWidth: 0, playheadX: 10 }) === null);

// ─── Jumps and manual scrolls ───

check('a loop wrap back to the start is a jump', isBackwardJump(12, 4));
check('forward playback is not a jump', !isBackwardJump(4, 4.02));
check('clock jitter is not a jump', !isBackwardJump(4, 4 - BACKWARD_JUMP_SEC / 2));
check('a scroll to where auto-scroll put the view is not manual', !isManualScroll(840, 840.4));
check('a sideways scroll the code did not make is manual', isManualScroll(840, 600));

// ─── Following and its pause ───

const on = { enabled: true, paused: false, resumed: false };
check('on: follows to the playhead', followStep(on, view(0, 950)).target === 850);
check('off: never scrolls', followStep({ ...on, enabled: false }, view(0, 950)).target === null);
check('paused: holds while the playhead is out of view',
  followStep({ ...on, paused: true }, view(4000, 950)).target === null
  && followStep({ ...on, paused: true }, view(4000, 950)).paused === true);
check('paused: resumes once the playhead is back in view',
  followStep({ ...on, paused: true }, view(4000, 4100)).paused === false);
check('paused: a seek or Play resumes and turns at once',
  followStep({ ...on, paused: true, resumed: true }, view(4000, 950)).target === 850);
check('paused: a playhead at the right edge after a look behind is not fought',
  followStep({ ...on, paused: true }, view(4000, 4950)).target === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
