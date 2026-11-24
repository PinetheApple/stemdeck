// Up Next: library track ids to play after the open song, kept in the store.
// Songs are queued through queueUpNext (UP_NEXT_ADD_EVENT); player.js reports "trackended" and "playbackready".

import {
  TRASH_CHANGE_EVENT,
  getPlayingTrackInfo,
  getLibraryTrack,
  isInTrash,
  isPlayableTrack,
  loadTrackIntoStudio,
  displayTitle,
  libraryTitle,
} from "./catalog.js";
import { togglePlayPause, stopTransport, transport } from "./transport.js";
import { t, onLanguageChange } from "./i18n.js";
import { $, fmtTime, storeGet, storeSet } from "./utils.js";
import { ROW_KEY, wireRovingRows } from "./rovingRows.js";

const STORE_KEY = "stemdeck.upNext";
const UPNEXT_ROW = ".upnext-row";
const UPNEXT_ROW_ACTIONS = ".upnext-play, .upnext-remove";
const MOVE_STEP = Object.freeze({ [ROW_KEY.PREVIOUS]: -1, [ROW_KEY.NEXT]: 1 });
const FRONT = null;
const NO_MOVE = undefined;
const DRAGGING_CLASS = "dragging";
const DROP_BELOW_CLASS = "drop-below";
const DRAG_EFFECT = "move";
const DRAG_PAYLOAD_TYPE = "text/plain";
const ROW_MIDPOINT = 0.5;

let queue = [];
let pendingAutoplay = null;
let upNextRows = null;
let draggedId = null;

async function readStoredQueue() {
  const stored = await storeGet(STORE_KEY, []);
  return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
}

function persist() {
  storeSet(STORE_KEY, queue);
}

/** Songs that left the library since they were queued are dropped quietly. */
function playableQueue() {
  return queue.filter(isPlayableTrack);
}

/** A trashed song leaves Up Next for good: restoring it does not queue it again. */
function dropTrashedSongs() {
  const kept = queue.filter((id) => !isInTrash(id));
  if (kept.length === queue.length) return;
  queue = kept;
  persist();
}

function addToUpNext(trackId) {
  if (!getLibraryTrack(trackId) || queue.includes(trackId)) return;
  queue.push(trackId);
  persist();
  renderUpNext();
}

function removeFromUpNext(trackId) {
  queue = queue.filter((id) => id !== trackId);
  persist();
  renderUpNext();
}

/** Empties Up Next and returns what it held. */
export function clearUpNext() {
  const removed = queue;
  queue = [];
  persist();
  renderUpNext();
  return removed;
}

/** A song's place in Up Next, counting songs that cannot play; -1 when it is not queued. */
export function upNextIndexOf(trackId) {
  return queue.indexOf(trackId);
}

/** Put `trackId` at `at` in Up Next, unless it has left the library or is queued already. */
export function insertUpNext(trackId, at) {
  if (!getLibraryTrack(trackId) || queue.includes(trackId)) return;
  queue.splice(at, 0, trackId);
  persist();
  renderUpNext();
}

/** Put `trackId` right after `anchorId` in the queue, or first for FRONT. */
function moveInUpNext(trackId, anchorId) {
  const rest = queue.filter((id) => id !== trackId);
  rest.splice(anchorId === FRONT ? 0 : rest.indexOf(anchorId) + 1, 0, trackId);
  queue = rest;
  persist();
  renderUpNext();
}

/** The song `trackId` goes after when moved `step` rows, FRONT, or NO_MOVE past either end. */
function anchorForStep(ids, trackId, step) {
  const from = ids.indexOf(trackId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return NO_MOVE;
  const others = ids.filter((id) => id !== trackId);
  return to === 0 ? FRONT : others[to - 1];
}

/** Open a queued song and start it; everything queued before it is skipped. */
async function playFromUpNext(trackId) {
  const at = queue.indexOf(trackId);
  if (at < 0) return;
  queue = queue.slice(at + 1);
  persist();
  renderUpNext();
  await loadAndPlay(trackId);
}

export function isInUpNext(trackId) {
  return queue.includes(trackId);
}

export function firstInUpNext() {
  return playableQueue()[0] ?? null;
}

/** The song in the player, when it can be played, then what is queued after it. */
export function getNowAndUpNextIds() {
  const current = getPlayingTrackInfo()?.id;
  const now = isPlayableTrack(current) ? [current] : [];
  return [...new Set([...now, ...playableQueue()])];
}

/** Stop what plays, then open `trackId` and start it; Up Next stays as it is. */
export async function playNow(trackId) {
  if (transport()?.isPlaying()) stopTransport();
  await loadAndPlay(trackId);
}

export function playNextInUpNext() {
  const next = firstInUpNext();
  if (!next) return;
  if (transport()?.isPlaying()) stopTransport();
  playFromUpNext(next);
}

let trackEndOverride = null;

/** Lets a view take over a song's end: `override(nextId)` returns true when it handles it. */
export function setTrackEndOverride(override) {
  trackEndOverride = override;
}

function onTrackEnded() {
  if (trackEndOverride?.(playableQueue()[0] ?? null)) return;
  playNextInUpNext();
}

/** Start `trackId` as soon as it has loaded, as a song played from Up Next is. */
export function playWhenLoaded(trackId) {
  pendingAutoplay = trackId;
}

/** Nothing starts by itself on its next load. */
export function cancelPlayWhenLoaded() {
  pendingAutoplay = null;
}

/** Load a song and start it; a song that cannot load leaves nothing waiting to start. */
export async function loadAndPlay(trackId) {
  pendingAutoplay = trackId;
  const loaded = await loadTrackIntoStudio(trackId);
  if (!loaded && pendingAutoplay === trackId) pendingAutoplay = null;
}

/** Whether the song that just ended hands the studio to Up Next. */
export function upNextTakesOver() {
  return pendingAutoplay !== null || playableQueue().length > 0;
}

function onPlaybackReady(e) {
  if (!pendingAutoplay || e.detail?.id !== pendingAutoplay) return;
  pendingAutoplay = null;
  if (!transport()?.isPlaying()) togglePlayPause();
}

export const UP_NEXT_ADD_EVENT = "upnext:add";
export const UP_NEXT_CHANGE_EVENT = "upnext:change";

/** Queue a song from anywhere, without importing this module's state. */
export function queueUpNext(trackId) {
  document.dispatchEvent(new CustomEvent(UP_NEXT_ADD_EVENT, { detail: { id: trackId } }));
}

function onAddRequest(e) {
  const id = e.detail?.id;
  if (id) addToUpNext(id);
}

function thumbEl(track) {
  const box = document.createElement("span");
  box.className = "upnext-thumb";
  box.setAttribute("aria-hidden", "true");
  if (track.thumb) {
    const img = document.createElement("img");
    img.src = track.thumb;
    img.alt = "";
    img.loading = "lazy";
    box.append(img);
  } else {
    box.textContent = displayTitle(libraryTitle(track)).trim().charAt(0).toUpperCase();
  }
  return box;
}

function songText(track) {
  const text = document.createElement("span");
  text.className = "upnext-text";
  const title = document.createElement("span");
  title.className = "upnext-title";
  title.textContent = displayTitle(libraryTitle(track));
  const sub = document.createElement("span");
  sub.className = "upnext-sub num";
  sub.textContent = track.duration ? fmtTime(track.duration) : "";
  text.append(title, sub);
  return text;
}

export function upNextButton(className, title, label = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = title;
  if (label) button.setAttribute("aria-label", label);
  return button;
}

/** A row of song `trackId`: Play now holding `lead`, the cover and the title, then `action`. */
export function upNextRowEl(trackId, { lead = [], onPlay, action }) {
  const track = getLibraryTrack(trackId);
  const li = document.createElement("li");
  li.className = "upnext-row";
  li.dataset.id = trackId;
  const play = upNextButton("upnext-play", t("upNext.playNow"));
  play.append(...lead, thumbEl(track), songText(track));
  play.addEventListener("click", onPlay);
  li.append(play, action);
  return li;
}

function queueRow(trackId, position) {
  const title = displayTitle(libraryTitle(getLibraryTrack(trackId)));
  const index = document.createElement("span");
  index.className = "upnext-index num";
  index.textContent = String(position);
  const remove = upNextButton("upnext-remove", t("upNext.remove"), t("upNext.removeTitle", { title }));
  remove.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  remove.addEventListener("click", function onRemoveQueuedSong() {
    removeFromUpNext(trackId);
  });
  const li = upNextRowEl(trackId, {
    lead: [index],
    onPlay: function onPlayQueuedSong() {
      playFromUpNext(trackId);
    },
    action: remove,
  });
  li.draggable = true;
  return li;
}

function renderNowPlaying() {
  const box = $("upNextNow");
  if (!box) return;
  box.replaceChildren();
  const info = getPlayingTrackInfo();
  const track = info && getLibraryTrack(info.id);
  if (!track) {
    const none = document.createElement("span");
    none.className = "upnext-none";
    none.textContent = t("upNext.nothingPlaying");
    box.append(none);
    return;
  }
  box.append(thumbEl(track), songText(track));
}

export function renderUpNext() {
  // Here rather than only on a trash: the stored list can arrive before the
  // library, and is checked again once it has loaded.
  dropTrashedSongs();
  const ids = playableQueue();
  const list = $("upNextList");
  if (list) {
    const saved = upNextRows?.remember();
    list.replaceChildren(...ids.map((id, i) => queueRow(id, i + 1)));
    upNextRows?.restore(saved);
  }

  const empty = !ids.length;
  const emptyEl = $("upNextEmpty");
  if (emptyEl) emptyEl.hidden = !empty;
  const clear = $("upNextClear");
  if (clear) clear.hidden = empty;
  const count = $("upNextCount");
  if (count) {
    count.textContent = String(ids.length);
    count.hidden = empty;
  }
  renderNowPlaying();
  document.dispatchEvent(new CustomEvent(UP_NEXT_CHANGE_EVENT, { detail: { count: ids.length, nextId: ids[0] ?? null } }));
}

/** Songs queued before the stored list arrived stay queued, after it. */
async function restoreQueue() {
  const stored = await readStoredQueue();
  queue = [...stored, ...queue.filter((id) => !stored.includes(id))];
  renderUpNext();
}

function upNextRowKey(row) {
  return row.dataset.id;
}

function playUpNextRow(row) {
  playFromUpNext(row.dataset.id);
}

function onUpNextMoveKey(e) {
  const step = MOVE_STEP[e.key];
  if (!step || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const row = e.target.closest?.(UPNEXT_ROW);
  if (!row) return;
  e.preventDefault();
  const anchor = anchorForStep(playableQueue(), row.dataset.id, step);
  if (anchor !== NO_MOVE) moveInUpNext(row.dataset.id, anchor);
}

/** The id the dragged row should sit after, given where it was dropped, or FRONT. */
function dropAnchorId(list, clientY) {
  let anchor = FRONT;
  for (const row of list.querySelectorAll(UPNEXT_ROW)) {
    if (row.dataset.id === draggedId) continue;
    const box = row.getBoundingClientRect();
    if (clientY > box.top + box.height * ROW_MIDPOINT) anchor = row.dataset.id;
  }
  return anchor;
}

function showDropAnchor(list, anchor) {
  for (const row of list.querySelectorAll(UPNEXT_ROW)) {
    row.classList.toggle(DROP_BELOW_CLASS, row.dataset.id === anchor);
  }
}

function clearDropAnchor(list) {
  for (const row of list.querySelectorAll(UPNEXT_ROW)) row.classList.remove(DROP_BELOW_CLASS);
}

function onUpNextDragStart(e) {
  const row = e.target.closest?.(UPNEXT_ROW);
  if (!row) return;
  draggedId = row.dataset.id;
  row.classList.add(DRAGGING_CLASS);
  e.dataTransfer.effectAllowed = DRAG_EFFECT;
  // Firefox refuses to start a drag without payload.
  e.dataTransfer.setData(DRAG_PAYLOAD_TYPE, draggedId);
}

function onUpNextDragEnd(e) {
  draggedId = null;
  e.target.closest?.(UPNEXT_ROW)?.classList.remove(DRAGGING_CLASS);
  clearDropAnchor(e.currentTarget);
}

function onUpNextDragOver(e) {
  if (!draggedId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = DRAG_EFFECT;
  showDropAnchor(e.currentTarget, dropAnchorId(e.currentTarget, e.clientY));
}

function onUpNextDrop(e) {
  if (!draggedId) return;
  e.preventDefault();
  const dragged = draggedId;
  const anchor = dropAnchorId(e.currentTarget, e.clientY);
  draggedId = null;
  clearDropAnchor(e.currentTarget);
  moveInUpNext(dragged, anchor);
}

function wireUpNextReorder(list) {
  list.addEventListener("keydown", onUpNextMoveKey);
  list.addEventListener("dragstart", onUpNextDragStart);
  list.addEventListener("dragend", onUpNextDragEnd);
  list.addEventListener("dragover", onUpNextDragOver);
  list.addEventListener("drop", onUpNextDrop);
}

function wireUpNextRows() {
  const list = $("upNextList");
  if (!list) return;
  wireUpNextReorder(list);
  upNextRows = wireRovingRows(
    list,
    {
      rowSelector: UPNEXT_ROW,
      actionSelector: UPNEXT_ROW_ACTIONS,
      keyOf: upNextRowKey,
      openRow: playUpNextRow,
    },
  );
}

export function initUpNext() {
  wireUpNextRows();
  document.addEventListener(UP_NEXT_ADD_EVENT, onAddRequest);
  document.addEventListener("trackended", onTrackEnded);
  document.addEventListener("playbackready", onPlaybackReady);
  document.addEventListener("trackopen", renderUpNext);
  document.addEventListener("tracknames", renderUpNext);
  document.addEventListener(TRASH_CHANGE_EVENT, renderUpNext);
  onLanguageChange(renderUpNext);
  renderUpNext();
  restoreQueue().catch(console.error);
}
