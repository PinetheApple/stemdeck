import {
  defaultGrouping,
  groupOffsets,
  LEVEL_DOWNBEAT,
  LEVEL_GROUP,
  LEVEL_WEAK,
  normaliseGrouping,
} from "./metronome.js";

// ─── Count-in (issue #269) ───────────────────────────────────────────────
//
// A count-in is one bar of click *before* playback, leading into the start
// position. The maths below is a literal mirror of count_in_beats() in
// app/pipeline/click_render.py so the live count-in and the exported one agree
// beat-for-beat -- the same parity discipline that pins the click voice across
// the two files. Kept pure and module-level so it can be unit-tested and reused
// by the export URL builder without a live AudioContext.

function _rescaleForCount(beats, mult) {
  if (mult === 2) {
    const out = [];
    for (let i = 0; i < beats.length - 1; i++) out.push(beats[i], (beats[i] + beats[i + 1]) / 2);
    if (beats.length) out.push(beats[beats.length - 1]);
    return out;
  }
  if (mult === 0.5) return beats.filter((_, i) => i % 2 === 0);
  return beats.slice();
}

function _countInBeatsPerBar(bars, accentMode, startIndex) {
  if (accentMode > 0) return accentMode;
  // Auto / off: the detected meter in force at the start beat, else 4. A
  // count-in always needs a bar length, even with accents switched off.
  let mark = null;
  for (const b of bars) {
    if (Number.isInteger(b.beat) && b.beat <= startIndex) mark = b;
    else break;
  }
  if (mark && Number.isInteger(mark.beats_per_bar) && mark.beats_per_bar >= 1) {
    return mark.beats_per_bar;
  }
  return 4;
}

function _intervalNear(grid, start, span) {
  if (grid.length < 2) return null;
  let i = 0;
  while (i < grid.length && grid[i] < start) i++;
  i = Math.min(i, grid.length - 2);
  const diffs = [];
  for (let k = i; k < Math.min(i + Math.max(1, span), grid.length - 1); k++) {
    const d = grid[k + 1] - grid[k];
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

/**
 * The count-in that leads into playback at `start`.
 * @returns {{leadIn:number, clicks:{offset:number, level:number, accent:boolean}[]}}
 *   `leadIn` seconds of pre-roll, and clicks at offsets in `[0, leadIn)`.
 *   `level` is LEVEL_WEAK/GROUP/DOWNBEAT; `accent` stays as the downbeat-only
 *   boolean so callers that only care about "is this the 1" keep working.
 */
export function computeCountIn(
  beats,
  bars,
  { countBars = 1, multiplier = 1, accentMode = -1, start = 0, groups = null } = {},
) {
  if (countBars < 1) return { leadIn: 0, clicks: [] };
  const clean = Array.isArray(beats) ? beats.filter((b) => Number.isFinite(b)) : [];
  const grid = _rescaleForCount(clean, multiplier);
  let startIndex = 0;
  for (let k = 0; k < clean.length; k++) {
    if (clean[k] <= start) startIndex = k;
    else break;
  }
  const bpb = _countInBeatsPerBar(Array.isArray(bars) ? bars : [], accentMode, startIndex);
  const interval = _intervalNear(grid, start, bpb);
  if (interval === null) return { leadIn: 0, clicks: [] };
  const n = countBars * bpb;
  // The count-in is its own run of bars, so the grouping comes from bpb rather
  // than from the bar marks: there is no detected bar in front of the audio.
  // A user grouping only applies to an explicit meter, matching count_in_beats.
  const barGroups = accentMode > 0 ? normaliseGrouping(groups, bpb) : defaultGrouping(bpb);
  const starts = groupOffsets(barGroups);
  const clicks = [];
  for (let j = 0; j < n; j++) {
    const offset = j % bpb;
    const level = offset === 0 ? LEVEL_DOWNBEAT : starts.has(offset) ? LEVEL_GROUP : LEVEL_WEAK;
    clicks.push({ offset: j * interval, level, accent: offset === 0 });
  }
  return { leadIn: n * interval, clicks };
}
