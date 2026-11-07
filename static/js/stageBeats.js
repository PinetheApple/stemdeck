// Stage mode's bar and beat maths, apart from stageMode.js so it can be tested without a DOM.

import { currentLineIndex } from "./lyricsLookup.js";

const wrap = (n, length) => ((n % length) + length) % length;

function firstPosition(count, positionAt) {
  for (let index = 0; index < count; index++) {
    const position = positionAt(index);
    if (position) return { index, offset: position[0], length: position[1] };
  }
  return null;
}

/**
 * One `{ time, bar, beat, length }` per beat, bars and beats counted from 1.
 * `positionAt(i)` is the beat's `[offset, barLength]`, or null when no bar mark
 * applies: the first mark's bar is then run backwards from it, and with no mark
 * at all the bars run from the first beat at `fallbackLength`.
 */
export function buildBeatTable(beats, positionAt, fallbackLength) {
  const first = firstPosition(beats.length, positionAt) ?? { index: 0, offset: 0, length: fallbackLength };
  let bar = 0;
  return beats.map((time, i) => {
    const [offset, length] = positionAt(i) ?? [wrap(first.offset + i - first.index, first.length), first.length];
    if (i === 0 || offset === 0) bar++;
    return { time, bar, beat: offset + 1, length };
  });
}

/** The table's entry in force at `time`, or null before the first beat. */
export function beatAt(table, time) {
  return table[currentLineIndex(table, time)] ?? null;
}
