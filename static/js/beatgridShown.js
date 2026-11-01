// The beat grid drawn over the lanes while the click plays, apart from
// beatgrid.js so the thinning can be tested without a DOM.

export const SHOWN_MIN_PX = 12;
const HALF_RATE = 0.5;
const DOUBLE_RATE = 2;

/** The lines the click plays at `rate`: every other beat at half, the midpoints added at double. */
export function clickLines(beats, isBar, rate) {
  const lines = [];
  for (let i = 0; i < beats.length; i++) {
    if (rate === HALF_RATE && i % 2) continue;
    lines.push({ t: beats[i], bar: isBar(i) });
    if (rate === DOUBLE_RATE && i + 1 < beats.length) {
      lines.push({ t: (beats[i] + beats[i + 1]) / 2, bar: false });
    }
  }
  return lines;
}

const meanGap = (lines) => (lines.length < 2 ? Infinity : (lines.at(-1).x - lines[0].x) / (lines.length - 1));

/**
 * `lines` placed by `toX` and thinned in musical steps until they sit `minPx` apart:
 * every beat, then bar lines only, then every 2nd, 4th, 8th... bar.
 */
export function thinLines(lines, toX, minPx = SHOWN_MIN_PX) {
  const placed = lines.map((line) => ({ ...line, x: toX(line.t) }));
  if (meanGap(placed) >= minPx) return placed;
  const bars = placed.filter((line) => line.bar);
  const units = bars.length ? bars : placed;
  const gap = meanGap(units);
  let step = 1;
  while (step * gap < minPx && step < units.length) step *= 2;
  return units.filter((_, i) => i % step === 0);
}
