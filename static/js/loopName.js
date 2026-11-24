// Which section a loop covers, if any: the footer's Loop names it and its block shows it looping.

const MATCH_EPSILON_SEC = 0.001;

const near = (a, b) => Math.abs(a - b) <= MATCH_EPSILON_SEC;

/** The section whose span the loop covers, or null; `loop` is `{ enabled, start, end }`. */
export function loopedSection(loop, sections) {
  if (!loop?.enabled) return null;
  return sections.find((s) => near(s.start, loop.start) && near(s.end, loop.end)) ?? null;
}
