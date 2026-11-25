// Repeat's three states, the order the footer button goes through them, and what plays when a song ends.

export const REPEAT = Object.freeze({ OFF: "off", QUEUE: "queue", SONG: "song" });
const CLICK_ORDER = Object.freeze([REPEAT.OFF, REPEAT.QUEUE, REPEAT.SONG]);
export const SONG_END_STEP = Object.freeze({
  SONG_AGAIN: "songAgain",
  UP_NEXT: "upNext",
  LIST_NEXT: "listNext",
  UP_NEXT_AGAIN: "upNextAgain",
  LIST_AGAIN: "listAgain",
});

export function nextRepeat(mode) {
  return CLICK_ORDER[(CLICK_ORDER.indexOf(mode) + 1) % CLICK_ORDER.length];
}

export function readRepeat(stored) {
  return CLICK_ORDER.includes(stored) ? stored : REPEAT.OFF;
}

// With Repeat queue a setlist plays on first, then Up Next's run plays again, then a setlist loops; any other list repeats the song.
function queueRepeatStep({ listAhead, upNextPlayed, setlist, listPlayable }) {
  if (setlist && listAhead) return SONG_END_STEP.LIST_NEXT;
  if (upNextPlayed) return SONG_END_STEP.UP_NEXT_AGAIN;
  return setlist && listPlayable ? SONG_END_STEP.LIST_AGAIN : SONG_END_STEP.SONG_AGAIN;
}

/** What a song's end starts, first match wins; null when playback stops. */
export function songEndStep({ mode, queued, listAhead, upNextPlayed, setlist, listPlayable }) {
  if (mode === REPEAT.SONG) return SONG_END_STEP.SONG_AGAIN;
  if (queued) return SONG_END_STEP.UP_NEXT;
  if (mode === REPEAT.QUEUE) return queueRepeatStep({ listAhead, upNextPlayed, setlist, listPlayable });
  return listAhead ? SONG_END_STEP.LIST_NEXT : null;
}
