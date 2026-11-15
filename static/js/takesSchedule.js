// When a take's clip starts sounding, from the engine's clock mapping; pure, so
// seeks, loop wraps and speed changes can be tested under node.

// Far enough ahead that the first sample is never already in the past.
export const SCHEDULE_LEAD_SEC = 0.05;
const ONE_SECOND = 1;

/**
 * The song position scheduling starts from: where the sources will be a lead
 * from now, held at the output position while a count-in has not reached it.
 */
export function scheduleFrom(ctxToSource, nowCtx, outputSec) {
  return Math.max(outputSec, ctxToSource(nowCtx + SCHEDULE_LEAD_SEC));
}

/** How fast the sources read song time against the context clock. */
export function sourceRate(ctxToSource, atCtx) {
  return ctxToSource(atCtx + ONE_SECOND) - ctxToSource(atCtx);
}

/**
 * Context time and buffer offset to start a clip that covers
 * [clipStartSec, clipStartSec + clipSec) of the song, or null when `fromSec`
 * is already past it.
 */
export function planClip(clipStartSec, clipSec, fromSec, sourceToCtx) {
  if (fromSec >= clipStartSec + clipSec) return null;
  const begin = Math.max(clipStartSec, fromSec);
  return { when: sourceToCtx(begin), offset: begin - clipStartSec };
}
