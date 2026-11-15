// Click strength at one beat. click_render.py defines the same three.
export const LEVEL_WEAK = 0;
export const LEVEL_GROUP = 1;
export const LEVEL_DOWNBEAT = 2;

/**
 * How a bar of `beatsPerBar` divides when the user has not said.
 *
 * Mirror of default_grouping() in app/pipeline/click_render.py -- keep both in
 * step. 2, 3 and 4 deliberately return one group so they sound exactly as they
 * did; 4/4's real secondary stress on beat 3 is a choice for the user, not a
 * default that changes the commonest meter for everyone.
 * @param {number} beatsPerBar
 * @returns {number[]}
 */
export function defaultGrouping(beatsPerBar) {
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) return [];
  if (beatsPerBar === 5 || beatsPerBar === 7) {
    // Long group first: Take Five is 3+2, and 7/8 is more often 3+2+2.
    return [3, ...Array((beatsPerBar - 3) >> 1).fill(2)];
  }
  // Compound: 6, 9 and 12 are felt in dotted-quarter groups of three.
  if (beatsPerBar >= 6 && beatsPerBar % 3 === 0) return Array(beatsPerBar / 3).fill(3);
  return [beatsPerBar];
}

/**
 * A grouping safe to index a bar with, or the default. Anything that is not a
 * list of positive integers summing to the bar length is rejected wholesale
 * rather than repaired: a half-understood grouping would accent beats the user
 * never asked for, so falling back to the default is the honest failure.
 * @param {number[]|null|undefined} groups
 * @param {number} beatsPerBar
 * @returns {number[]}
 */
export function normaliseGrouping(groups, beatsPerBar) {
  if (!Number.isInteger(beatsPerBar) || beatsPerBar < 1) return [];
  if (!Array.isArray(groups) || !groups.length) return defaultGrouping(beatsPerBar);
  if (!groups.every((g) => Number.isInteger(g) && g >= 1)) return defaultGrouping(beatsPerBar);
  if (groups.reduce((a, b) => a + b, 0) !== beatsPerBar) return defaultGrouping(beatsPerBar);
  return groups.slice();
}

/** Beat offsets inside a bar that start a group, excluding the downbeat. */
export function groupOffsets(groups) {
  const out = new Set();
  let at = 0;
  for (let i = 0; i < groups.length - 1; i++) {
    at += groups[i];
    out.add(at);
  }
  return out;
}

/** The click level for a beat `offset` into a bar of `beatsPerBar`. */
export function levelAt(offset, beatsPerBar, groups) {
  if (offset === 0) return LEVEL_DOWNBEAT;
  return groupOffsets(normaliseGrouping(groups, beatsPerBar)).has(offset)
    ? LEVEL_GROUP
    : LEVEL_WEAK;
}
