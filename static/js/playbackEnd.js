// Track length and end checks shared by both engines, which hold a duration
// of 0 until the stems are read.

/** True when `duration` is a known, positive length in seconds. */
export function hasKnownLength(duration) {
  return Number.isFinite(duration) && duration > 0;
}

/**
 * @param {number} position  Playhead, in seconds.
 * @param {number} duration  Track length in seconds as the engine knows it.
 * @returns {boolean} True only when `duration` is finite and positive and
 *   `position` has reached it.
 */
export function reachedEnd(position, duration) {
  return hasKnownLength(duration) && position >= duration;
}
