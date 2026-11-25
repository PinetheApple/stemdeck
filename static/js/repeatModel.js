// Repeat's three states, the order the footer button goes through them, and what a song's end plays again.

export const REPEAT = Object.freeze({ OFF: "off", QUEUE: "queue", SONG: "song" });
const CLICK_ORDER = Object.freeze([REPEAT.OFF, REPEAT.QUEUE, REPEAT.SONG]);
/** Where the ended song sits in the list it was played from. */
export const LIST_AT = Object.freeze({ NONE: "none", AHEAD: "ahead", END: "end" });
export const REPEAT_START = Object.freeze({ SONG: "song", RUN: "run", LIST: "list" });
const SHORTEST_RUN = 2;

export function nextRepeat(mode) {
  return CLICK_ORDER[(CLICK_ORDER.indexOf(mode) + 1) % CLICK_ORDER.length];
}

export function readRepeat(stored) {
  return CLICK_ORDER.includes(stored) ? stored : REPEAT.OFF;
}

/**
 * What starts when a song ends: the song again, the songs played through Up Next
 * from their first, the list from its top, or null when nothing repeats.
 */
export function repeatAtEnd({ mode, queued, runLength, list }) {
  if (mode === REPEAT.SONG) return REPEAT_START.SONG;
  if (mode !== REPEAT.QUEUE || queued) return null;
  if (runLength >= SHORTEST_RUN) return REPEAT_START.RUN;
  if (list === LIST_AT.END) return REPEAT_START.LIST;
  return list === LIST_AT.NONE ? REPEAT_START.SONG : null;
}
