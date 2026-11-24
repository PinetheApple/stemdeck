// Setlists: named, ordered lists of library songs kept on the server
// (/api/setlists). The sidebar and Browse library draw them; Up Next stays client-side.

import { getPlayingTrackInfo, isPlayableTrack, makeFolderFromSetlist } from "./catalog.js";
import { getNowAndUpNextIds, playSongs } from "./upNext.js";
import { t, onLanguageChange } from "./i18n.js";
import {
  HTTP_NOT_FOUND,
  HttpError,
  SETLIST_NAME_MAX_CHARS,
  fetchJson,
  isNotFound,
  refusalReason,
} from "./libraryControls.js";
import { $ } from "./utils.js";
import { FOLDER_MOVING_KEY, isFolderMovingError } from "./folderMoving.js";
import { uniqueName } from "./listNames.js";

const SETLISTS_URL = "/api/setlists";
const STEP_UP = -1;
const STEP_DOWN = 1;

let setlists = [];
let lastError = "";
const listeners = new Set();
// Browse library shows a setlist; given here so this module need not import it.
let showSetlist = () => {};
let renameSetlistAfter = () => {};

function announce() {
  for (const listener of listeners) listener();
}

// ─── Server ───

const setlistUrl = (id) => `${SETLISTS_URL}/${encodeURIComponent(id)}`;

function showError(message = "") {
  lastError = message;
}

/**
 * Run a change against the server; a failure is said in the pane, not thrown.
 * When `creating`, no setlist existed yet, so a 404 is a failed save, not one gone.
 */
async function attempt(change, { creating = false } = {}) {
  try {
    const result = await change();
    showError();
    return result;
  } catch (err) {
    console.warn("[setlists] saving failed:", err);
    if (isNotFound(err) && !creating) {
      await loadSetlists();
      showError(t("setlists.gone"));
      return null;
    }
    const reason = refusalReason(err);
    if (isFolderMovingError(err)) showError(t(FOLDER_MOVING_KEY));
    else showError(reason ? t("setlists.rejected", { reason }) : t("setlists.saveFailed"));
    return null;
  } finally {
    announce();
  }
}

function replaceSetlist(updated) {
  setlists = setlists.map((setlist) => (setlist.id === updated.id ? updated : setlist));
}

async function fetchSetlists() {
  const list = await fetchJson(SETLISTS_URL);
  setlists = Array.isArray(list) ? list : [];
}

export async function loadSetlists() {
  try {
    await fetchSetlists();
    showError();
  } catch (err) {
    console.warn("[setlists] loading failed:", err);
    showError(t("setlists.loadFailed"));
  }
  announce();
}

function updateSetlist(id, patch) {
  return attempt(async () => {
    const updated = await fetchJson(setlistUrl(id), { method: "PATCH", body: patch });
    replaceSetlist(updated);
    return updated;
  });
}

/**
 * Change a setlist's songs from what the server holds now, so a change made in
 * another window is kept. `nextIds` returns the new order, or null for no change.
 */
function changeSongs(setlistId, nextIds) {
  return attempt(async () => {
    await fetchSetlists();
    const fresh = setlists.find((setlist) => setlist.id === setlistId);
    if (!fresh) throw new HttpError(HTTP_NOT_FOUND);
    const songIds = nextIds(fresh.song_ids);
    if (!songIds) return null;
    const updated = await fetchJson(setlistUrl(setlistId), { method: "PATCH", body: { song_ids: songIds } });
    replaceSetlist(updated);
    return updated;
  });
}

function deleteSetlist(id) {
  return attempt(async () => {
    await fetchJson(setlistUrl(id), { method: "DELETE" });
    setlists = setlists.filter((setlist) => setlist.id !== id);
  });
}

async function postSetlist(name, songIds) {
  const created = await fetchJson(SETLISTS_URL, { method: "POST", body: { name, song_ids: songIds } });
  setlists = [...setlists, created];
  return created;
}

function createSetlist(name, songIds = []) {
  return attempt(() => postSetlist(name, songIds), { creating: true });
}

// ─── Read and changed by the sidebar, Browse library, the track menu and Up Next ───

export function getSetlists() {
  return setlists;
}

export function getSetlist(id) {
  return setlists.find((setlist) => setlist.id === id) ?? null;
}

export function setlistsError() {
  return lastError;
}

export function onSetlistsChange(listener) {
  listeners.add(listener);
}

/** How a new or made setlist is shown: `show(id)` opens it, `rename(id)` asks for its name. */
export function setSetlistOpeners({ show, rename }) {
  showSetlist = show;
  renameSetlistAfter = rename;
}

function withSongInserted(trackId, at) {
  return function insertSong(ids) {
    if (ids.includes(trackId)) return null;
    const next = [...ids];
    next.splice(at, 0, trackId);
    return next;
  };
}

function withSongMoved(trackId, step) {
  return function moveSong(ids) {
    const from = ids.indexOf(trackId);
    const to = from + step;
    if (from < 0 || to < 0 || to >= ids.length) return null;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, trackId);
    return next;
  };
}

function withSongRemoved(trackId) {
  return function removeSong(ids) {
    return ids.includes(trackId) ? ids.filter((id) => id !== trackId) : null;
  };
}

export function addSongToSetlist(setlistId, trackId) {
  return changeSongs(setlistId, withSongInserted(trackId, Infinity));
}

export function insertSetlistSong(setlistId, trackId, at) {
  return changeSongs(setlistId, withSongInserted(trackId, at));
}

export function moveSetlistSongUp(setlistId, trackId) {
  return changeSongs(setlistId, withSongMoved(trackId, STEP_UP));
}

export function moveSetlistSongDown(setlistId, trackId) {
  return changeSongs(setlistId, withSongMoved(trackId, STEP_DOWN));
}

export function removeSetlistSong(setlistId, trackId) {
  return changeSongs(setlistId, withSongRemoved(trackId));
}

export function renameSetlist(id, name) {
  const setlist = getSetlist(id);
  if (!setlist || setlist.name === name) return null;
  return updateSetlist(id, { name });
}

export function removeSetlist(id) {
  return deleteSetlist(id);
}

const nextSetlistName = () => t("setlists.defaultName", { n: setlists.length + 1 });

/** An empty setlist under the next free "Setlist N", shown. */
export async function newSetlist() {
  const created = await createSetlist(nextSetlistName());
  if (created) showSetlist(created.id);
}

/** A new setlist of these songs, shown with its name asked for. */
export async function createSetlistFrom(trackIds) {
  const created = await createSetlist(nextSetlistName(), trackIds);
  if (!created) return;
  showSetlist(created.id);
  renameSetlistAfter(created.id);
}

/** A setlist of a folder's songs, under the folder's name or a free one, shown. */
export async function createSetlistFromFolder(folderName, songIds) {
  const created = await attempt(
    async function postUnderFreeName() {
      await fetchSetlists();
      const name = uniqueName(folderName, setlists.map((setlist) => setlist.name), SETLIST_NAME_MAX_CHARS);
      return postSetlist(name, songIds);
    },
    { creating: true },
  );
  if (created) showSetlist(created.id);
}

/** A folder of the setlist's songs that are out of the Trash; its id. */
export function makeFolderOf(id) {
  const setlist = getSetlist(id);
  return setlist ? makeFolderFromSetlist(setlist.name, setlist.song_ids) : null;
}

/** Load the first playable song with the rest as Up Next; false, and said, when none can play. */
export async function playSetlist(id) {
  const started = await playSongs(getSetlist(id)?.song_ids ?? []);
  if (!started) {
    showError(t("setlists.nothingToPlay"));
    announce();
  }
  return started;
}

export function canPlaySetlist(setlist) {
  return setlist.song_ids.some(isPlayableTrack);
}

export function isPlayingSong(trackId) {
  return trackId === getPlayingTrackInfo()?.id;
}

function renderSaveUpNext() {
  const save = $("upNextSave");
  if (save) save.hidden = !getNowAndUpNextIds().length;
}

function onSaveUpNextClick() {
  const ids = getNowAndUpNextIds();
  if (ids.length) createSetlistFrom(ids);
}

export function initSetlists() {
  $("upNextSave")?.addEventListener("click", onSaveUpNextClick);
  document.addEventListener("tracknames", announce);
  document.addEventListener("upnext:change", renderSaveUpNext);
  document.addEventListener("trackopen", renderSaveUpNext);
  onLanguageChange(announce);
  renderSaveUpNext();
  loadSetlists();
}
