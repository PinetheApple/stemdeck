import { isPlayableTrack } from "./catalog.js";
import { t } from "./i18n.js";
import { cursorAt, songsAhead } from "./playOrder.js";
import { onPlayStateChange } from "./playState.js";
import { isInUpNext, playNow } from "./upNext.js";

export const PLAY_CONTEXT_CHANGE_EVENT = "playcontext:change";
export const LIST_KIND = Object.freeze({ ALL: "all", FAVORITES: "favorites", FOLDER: "folder", SETLIST: "setlist" });
const KIND_LABEL_KEYS = Object.freeze({
  [LIST_KIND.ALL]: "studio.playList.allSongs",
  [LIST_KIND.FAVORITES]: "nav.favorites",
});
const LIST_SELECTOR = "[data-play-list]";
const LIST_SONG_SELECTOR = ".cat-item[data-id]:not(.cat-version):not(.in-trash):not(.queue-row)";
const NOT_STARTED = -1;
const NO_LIST = Object.freeze({ kind: null, name: "", ids: [], at: NOT_STARTED });

let list = NO_LIST;

function setList(next) {
  list = next;
  document.dispatchEvent(new CustomEvent(PLAY_CONTEXT_CHANGE_EVENT));
}

export function startPlayContext({ kind, name = "", ids }, trackId) {
  setList({ kind, name, ids, at: cursorAt({ ids, at: NOT_STARTED }, trackId) });
}

function shownSongIds(container) {
  return [...new Set([...container.querySelectorAll(LIST_SONG_SELECTOR)].map((row) => row.dataset.id))];
}

export function startPlayContextFromRow(row) {
  const container = row.closest(LIST_SELECTOR);
  if (!container) {
    setList(NO_LIST);
    return;
  }
  const { playList: kind, playListName: name } = container.dataset;
  startPlayContext({ kind, name, ids: shownSongIds(container) }, row.dataset.id);
}

/** Play a list from its first playable song, Up Next left as it is; false when none can play. */
export async function playList(list) {
  const first = list.ids.find(isPlayableTrack);
  if (!first) return false;
  startPlayContext(list, first);
  await playNow(first);
  return true;
}

export function playContextLabel() {
  const key = KIND_LABEL_KEYS[list.kind];
  return key ? t(key) : list.name;
}

const isAhead = (trackId) => isPlayableTrack(trackId) && !isInUpNext(trackId);

export function contextSongsAhead() {
  return songsAhead(list, isAhead);
}

export function nextInContext() {
  return contextSongsAhead()[0] ?? null;
}

function onPlayState({ id, playing }) {
  const at = playing ? cursorAt(list, id) : list.at;
  if (at !== list.at) setList({ ...list, at });
}

export function initPlayContext() {
  onPlayStateChange(onPlayState);
}
