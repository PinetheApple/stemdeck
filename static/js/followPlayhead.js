// When the zoomed timeline turns a page to keep the playhead in view. Pure, so
// node can test it; autoScroll.js applies it to the page.

// Fraction of the visible width the playhead may reach before the page turns.
export const TURN_AT = 0.9;
// Where the playhead lands after a turn, as a fraction of the visible width.
export const LAND_AT = 0.1;
// Scroll offsets closer than this are the same position.
const SAME_SCROLL_PX = 1;
// A step back smaller than this is clock jitter, not a seek or a loop wrap.
export const BACKWARD_JUMP_SEC = 0.25;

/** The scrollLeft that turns the page to the playhead, or null to leave the view alone. */
export function pageTurnTarget({ scrollLeft, viewportWidth, contentWidth, playheadX }) {
  const maxScroll = contentWidth - viewportWidth;
  if (!(viewportWidth > 0) || maxScroll <= 0) return null;
  const x = playheadX - scrollLeft;
  if (x >= 0 && x <= viewportWidth * TURN_AT) return null;
  const target = Math.max(0, Math.min(maxScroll, playheadX - viewportWidth * LAND_AT));
  return Math.abs(target - scrollLeft) < SAME_SCROLL_PX ? null : target;
}

/** A seek, a stop or a loop wrap: the clock went back further than jitter can. */
export function isBackwardJump(previousSec, sec) {
  return previousSec - sec > BACKWARD_JUMP_SEC;
}

/** Whether a scroll event moved the timeline sideways from where it was last known to be. */
export function isManualScroll(knownScrollLeft, scrollLeft) {
  return Math.abs(scrollLeft - knownScrollLeft) >= SAME_SCROLL_PX;
}

/**
 * One step of following. A manual scroll pauses it until the playhead is back
 * where no turn is needed, or until a seek or Play (`resumed`).
 */
export function followStep({ enabled, paused, resumed }, view) {
  if (!enabled) return { paused, target: null };
  const target = pageTurnTarget(view);
  if (paused && !resumed && target !== null) return { paused: true, target: null };
  return { paused: false, target };
}
