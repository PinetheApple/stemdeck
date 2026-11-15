// Fraction of the visible width the playhead may reach before the page turns.
export const TURN_AT = 0.9;
// Where the playhead lands after a turn, as a fraction of the visible width.
export const LAND_AT = 0.1;
// Scroll offsets closer than this are the same position.
const SAME_SCROLL_PX = 1;
// A step back smaller than this is clock jitter, not a seek or a loop wrap.
export const BACKWARD_JUMP_SEC = 0.25;
// How long after a wheel, press or key on the timeline a scroll still counts as the user's.
export const USER_INTENT_MS = 600;

export function isPlayheadInView({ scrollLeft, viewportWidth, playheadX }) {
  const x = playheadX - scrollLeft;
  return x >= 0 && x <= viewportWidth;
}

/** The scrollLeft that turns the page to the playhead, or null to leave the view alone. */
export function pageTurnTarget({ scrollLeft, viewportWidth, contentWidth, playheadX }, turnAt = TURN_AT) {
  const maxScroll = contentWidth - viewportWidth;
  if (!(viewportWidth > 0) || maxScroll <= 0) return null;
  const x = playheadX - scrollLeft;
  if (x >= 0 && x <= viewportWidth * turnAt) return null;
  const target = Math.max(0, Math.min(maxScroll, playheadX - viewportWidth * LAND_AT));
  return Math.abs(target - scrollLeft) < SAME_SCROLL_PX ? null : target;
}

/** A seek, a stop or a loop wrap: the clock went back further than jitter can. */
export function isBackwardJump(previousSec, sec) {
  return previousSec - sec > BACKWARD_JUMP_SEC;
}

/** Zoom, a song switch or a resize also scroll the timeline; only a move the user just asked for pauses following. */
export function isUserScroll({ knownScrollLeft, scrollLeft, sinceIntentMs, pointerHeld }) {
  if (Math.abs(scrollLeft - knownScrollLeft) < SAME_SCROLL_PX) return false;
  return pointerHeld || sinceIntentMs <= USER_INTENT_MS;
}

function isPastTurnPoint({ scrollLeft, viewportWidth, playheadX }) {
  return playheadX - scrollLeft >= viewportWidth * TURN_AT;
}

/**
 * A manual scroll pauses following until the playhead is back in view, or a seek or Play (`resumed`).
 * Back in view, or sought to, past the turn point, it waits for the right edge (`holdToEdge`)
 * rather than pull the view away.
 */
export function followStep({ enabled, paused, resumed, holdToEdge = false }, view) {
  if (!enabled) return { paused, holdToEdge, target: null };
  if (paused && !resumed && !isPlayheadInView(view)) return { paused: true, holdToEdge, target: null };
  const hold = paused || resumed ? isPastTurnPoint(view) : holdToEdge;
  const target = pageTurnTarget(view, hold ? 1 : TURN_AT);
  return { paused: false, holdToEdge: hold && target === null, target };
}
