// When a playhead position counts as the end of a track, for both engines.
// They start with a duration of 0 until the stems are read, and position 0 is
// "at or past" that, so only a known positive duration has an end.

/**
 * @param {number} position  Playhead, in seconds.
 * @param {number} duration  Track length in seconds as the engine knows it.
 * @returns {boolean} True only when `duration` is finite and positive and
 *   `position` has reached it.
 */
export function reachedEnd(position, duration) {
  return Number.isFinite(duration) && duration > 0 && position >= duration;
}
