// The list a song was played from (a setlist, a folder, Favorites, All songs), so
// Next can go on through it once Up Next runs out. A list on screen names itself with
// data-play-list; its song rows give its songs, in the order shown.

import { isPlayableTrack } from "./catalog.js";
import { cursorAt, songsAhead } from "./playOrder.js";
import { isInUpNext, playNow } from "./upNext.js";

export const PLAY_CONTEXT_CHANGE_EVENT = "playcontext:change";
const LIST_SELECTOR = "[data-play-list]";
const LIST_SONG_SELECTOR = ".cat-item[data-id]:not(.cat-version):not(.in-trash):not(.queue-row)";
const NOT_STARTED = -1;
const NO_LIST = Object.freeze({ label: "", ids: [], at: NOT_STARTED });

let list = NO_LIST;

function setList(next) {
  list = next;
  document.dispatchEvent(new CustomEvent(PLAY_CONTEXT_CHANGE_EVENT));
}

function startList(label, ids, trackId) {
  setList({ label, ids, at: cursorAt({ ids, at: NOT_STARTED }, trackId) });
}

function shownSongIds(container) {
  return [...new Set([...container.querySelectorAll(LIST_SONG_SELECTOR)].map((row) => row.dataset.id))];
}

/** A song row is played: its list becomes the one Next follows, or none when it is in no list. */
export function startPlayContextFromRow(row) {
  const container = row.closest(LIST_SELECTOR);
  if (container) startList(container.dataset.playList, shownSongIds(container), row.dataset.id);
  else setList(NO_LIST);
}

/** Play a list from its first playable song, Up Next left as it is; false when none can play. */
export async function playList({ label, ids }) {
  const first = ids.find(isPlayableTrack);
  if (!first) return false;
  startList(label, ids, first);
  await playNow(first);
  return true;
}

const isAhead = (trackId) => isPlayableTrack(trackId) && !isInUpNext(trackId);

export function playContextLabel() {
  return list.label;
}

/** The list's songs Next would go on to, in order, once Up Next is empty. */
export function contextSongsAhead() {
  return songsAhead(list, isAhead);
}

export function nextInContext() {
  return contextSongsAhead()[0] ?? null;
}

function onTrackOpen(e) {
  const at = cursorAt(list, e.detail?.id);
  if (at !== list.at) setList({ ...list, at });
}

export function initPlayContext() {
  document.addEventListener("trackopen", onTrackOpen);
}
