// Sing along's rules, apart from the view so they can be tested without a DOM.

import { currentLineIndex, firstSungIndex } from "./lyricsLookup.js";

const SING_STORE_PREFIX = "stemdeck:singalong:";
const VOCAL_STEM = "vocals";
const MS_PER_SECOND = 1000;

/** The song's Sing along state, kept beside its mix and never in it. */
export const singStoreKey = (jobId) => `${SING_STORE_PREFIX}${jobId}`;

export const voiceOnFrom = (stored) => stored?.voice === true;

/** Whether the song plays its lead and backing vocals as two lanes. */
export function vocalSplit(loadedNames, [lead, backing]) {
  const loaded = new Set(loadedNames);
  return loaded.has(lead) && loaded.has(backing);
}

/**
 * The vocal stems to keep quiet. With a full split, Voice is the lead and Backing the
 * backing; without one, Voice covers every vocal stem the song loaded.
 */
export function silencedVocals({ split, voiceOn, backingOn }, loadedNames, [lead, backing]) {
  if (split) return [...(voiceOn ? [] : [lead]), ...(backingOn ? [] : [backing])];
  if (voiceOn) return [];
  const loaded = new Set(loadedNames);
  return [VOCAL_STEM, lead, backing].filter((name) => loaded.has(name));
}

/**
 * The line in the middle of the view: before the first sung line, that line with the
 * seconds left until it (`intro`); after, the line at `time`. Null with nothing to sing.
 */
export function lyricWindow(lines, time) {
  const first = firstSungIndex(lines);
  if (first < 0) return null;
  const firstTime = lines[first].time;
  if (time < firstTime) return { intro: firstTime - time, now: first };
  return { intro: null, now: currentLineIndex(lines, time) };
}

/** Whole seconds left, the share of the time left, and whether it ran out. */
export function countdownState(elapsedMs, totalMs) {
  const leftMs = Math.max(0, totalMs - elapsedMs);
  return {
    left: Math.ceil(leftMs / MS_PER_SECOND),
    share: leftMs / totalMs,
    done: leftMs === 0,
  };
}
