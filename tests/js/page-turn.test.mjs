// Auto-scroll's page-turn and pause decisions (static/js/pageTurn.js).
//
// Run:  node tests/js/page-turn.test.mjs

import {
  pageTurnTarget, isBackwardJump, isUserScroll, followStep,
  TURN_AT, LAND_AT, BACKWARD_JUMP_SEC, USER_INTENT_MS,
} from '../../static/js/pageTurn.js';

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
const scroll = (moreProps) => ({
  knownScrollLeft: 840, scrollLeft: 600, sinceIntentMs: Infinity, pointerHeld: false, ...moreProps,
});
check('a scroll right after a pan, press or key is the user', isUserScroll(scroll({ sinceIntentMs: 50 })));
check('a scrollbar drag is the user for as long as the pointer is held', isUserScroll(scroll({ pointerHeld: true })));
check('a scroll with no gesture on the timeline (zoom, song switch, resize) is not',
  !isUserScroll(scroll({})));
check('a smooth scroll that ends long after the gesture is not',
  !isUserScroll(scroll({ sinceIntentMs: USER_INTENT_MS + 1 })));
check('a vertical scroll that leaves scrollLeft alone is not', !isUserScroll(scroll({ scrollLeft: 840.4, sinceIntentMs: 0 })));

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
const resumedAt95 = followStep({ ...on, paused: true }, view(4000, 4950));
check('paused: back in view at 95% resumes without pulling the view away',
  resumedAt95.paused === false && resumedAt95.target === null && resumedAt95.holdToEdge === true);
check('held: no turn while the playhead is still on the page',
  followStep({ ...on, holdToEdge: true }, view(4000, 4990)).target === null);
check('held: turns once the playhead leaves the right edge',
  followStep({ ...on, holdToEdge: true }, view(4000, 5010)).target === 4910);
const afterHeldTurn = followStep({ ...on, holdToEdge: true }, view(4000, 5010));
check('after the held turn, turns go back to 90%',
  afterHeldTurn.holdToEdge === false
  && followStep({ ...on, holdToEdge: afterHeldTurn.holdToEdge }, view(4910, 4910 + 950)).target !== null);
check('paused: back in view before the turn point resumes as normal',
  followStep({ ...on, paused: true }, view(4000, 4500)).holdToEdge === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
