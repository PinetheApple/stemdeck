import { favoriteTrackIds, folderTrackIds, isPlayableTrack, libraryFolderTree, libraryTrackIds } from "./catalog.js";
import { t } from "./i18n.js";
import { cursorAt, songsAhead } from "./playOrder.js";
import { onPlayStateChange } from "./playState.js";
import { getSetlist } from "./setlists.js";
import { isInUpNext, playNow } from "./upNext.js";

export const PLAY_CONTEXT_CHANGE_EVENT = "playcontext:change";
export const LIST_KIND = Object.freeze({ ALL: "all", FAVORITES: "favorites", FOLDER: "folder", SETLIST: "setlist" });
const KIND_LABEL_KEYS = Object.freeze({
  [LIST_KIND.ALL]: "studio.playList.allSongs",
  [LIST_KIND.FAVORITES]: "nav.favorites",
});
const LIST_SONGS = Object.freeze({
  [LIST_KIND.ALL]: () => libraryTrackIds(),
  [LIST_KIND.FAVORITES]: () => favoriteTrackIds(),
  [LIST_KIND.FOLDER]: (id) => folderTrackIds(id),
  [LIST_KIND.SETLIST]: (id) => getSetlist(id)?.song_ids ?? [],
});
const LIST_NAMES = Object.freeze({
  [LIST_KIND.FOLDER]: (id) => libraryFolderTree().find((folder) => folder.id === id)?.name,
  [LIST_KIND.SETLIST]: (id) => getSetlist(id)?.name,
});
const LIST_SELECTOR = "[data-play-list]";
const NOT_STARTED = -1;
const NO_LIST = Object.freeze({ kind: null, id: "", ids: [], at: NOT_STARTED });

let list = NO_LIST;

function setList(next) {
  list = next;
  document.dispatchEvent(new CustomEvent(PLAY_CONTEXT_CHANGE_EVENT));
}

// The whole list, whatever a search or the playing song adds to or hides from its rows.
function listSongs(kind, id) {
  if (!(kind in LIST_SONGS)) throw new Error(`playContext: unknown list kind "${kind}"; use LIST_KIND`);
  return LIST_SONGS[kind](id);
}

function startList(kind, id, trackId) {
  const ids = listSongs(kind, id);
  setList({ kind, id, ids, at: cursorAt({ ids, at: NOT_STARTED }, trackId) });
}

export function startPlayContextFromRow(row) {
  const { playList: kind, playListId: id = "" } = row.closest(LIST_SELECTOR)?.dataset ?? {};
  if (kind in LIST_SONGS) startList(kind, id, row.dataset.id);
  else setList(NO_LIST);
}

/** Play a list ({ kind, id }) from its first playable song, Up Next left as it is; false when none can play. */
export async function playList({ kind, id = "" }) {
  const first = listSongs(kind, id).find(isPlayableTrack);
  if (!first) return false;
  startList(kind, id, first);
  await playNow(first);
  return true;
}

export function hasPlayList() {
  return list.kind !== null;
}

/** The list plays again from its first playable song. */
export function playListAgain() {
  return playList(list);
}

export function playContextLabel() {
  const key = KIND_LABEL_KEYS[list.kind];
  return key ? t(key) : LIST_NAMES[list.kind]?.(list.id) ?? "";
}

const isAhead = (trackId) => isPlayableTrack(trackId) && !isInUpNext(trackId);

export function contextSongsAhead() {
  return songsAhead(list, isAhead);
}

export function nextInContext() {
  return contextSongsAhead()[0] ?? null;
}

function onPlayState({ id, playing }) {
  if (!playing) return;
  const at = cursorAt(list, id);
  if (at !== list.at) setList({ ...list, at });
}

export function initPlayContext() {
  onPlayStateChange(onPlayState);
}
