// Up Next: library track ids to play after the open song, kept in the store.
// catalog.js queues songs via "upnext:add"; player.js reports "trackended" and "playbackready".

import { getCurrentTrackInfo, getLibraryTrack, loadTrackIntoStudio, displayTitle } from "./catalog.js";
import { togglePlayPause, stopTransport, transport } from "./transport.js";
import { t, onLanguageChange } from "./i18n.js";
import { $, fmtTime, storeGet, storeSet } from "./utils.js";

const STORE_KEY = "stemdeck.upNext";

let queue = [];
let pendingAutoplay = null;

async function readStoredQueue() {
  const stored = await storeGet(STORE_KEY, []);
  return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
}

function persist() {
  storeSet(STORE_KEY, queue);
}

/** Songs that left the library since they were queued are dropped quietly. */
function playableQueue() {
  return queue.filter((id) => getLibraryTrack(id)?.status === "done");
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

function clearUpNext() {
  queue = [];
  persist();
  renderUpNext();
}

/** Open a queued song and start it; everything queued before it is skipped. */
async function playFromUpNext(trackId) {
  const at = queue.indexOf(trackId);
  if (at < 0) return;
  queue = queue.slice(at + 1);
  persist();
  renderUpNext();
  pendingAutoplay = trackId;
  await loadTrackIntoStudio(trackId);
}

export function playNextInUpNext() {
  const [next] = playableQueue();
  if (!next) return;
  if (transport()?.isPlaying()) stopTransport();
  playFromUpNext(next);
}

function onTrackEnded() {
  playNextInUpNext();
}

function onPlaybackReady(e) {
  if (!pendingAutoplay || e.detail?.id !== pendingAutoplay) return;
  pendingAutoplay = null;
  if (!transport()?.isPlaying()) togglePlayPause();
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
    box.textContent = displayTitle(track.title).trim().charAt(0).toUpperCase();
  }
  return box;
}

function songText(track) {
  const text = document.createElement("span");
  text.className = "upnext-text";
  const title = document.createElement("span");
  title.className = "upnext-title";
  title.textContent = displayTitle(track.title);
  const sub = document.createElement("span");
  sub.className = "upnext-sub num";
  sub.textContent = track.duration ? fmtTime(track.duration) : "";
  text.append(title, sub);
  return text;
}

function queueRow(trackId, position) {
  const track = getLibraryTrack(trackId);
  const li = document.createElement("li");
  li.className = "upnext-row";
  li.dataset.id = trackId;

  const play = document.createElement("button");
  play.type = "button";
  play.className = "upnext-play";
  play.title = t("upNext.playNow");
  const index = document.createElement("span");
  index.className = "upnext-index num";
  index.textContent = String(position);
  play.append(index, thumbEl(track), songText(track));
  play.addEventListener("click", function onPlayQueuedSong() {
    playFromUpNext(trackId);
  });

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "upnext-remove";
  remove.title = t("upNext.remove");
  remove.setAttribute("aria-label", t("upNext.removeTitle", { title: displayTitle(track.title) }));
  remove.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  remove.addEventListener("click", function onRemoveQueuedSong() {
    removeFromUpNext(trackId);
  });

  li.append(play, remove);
  return li;
}

function renderNowPlaying() {
  const box = $("upNextNow");
  if (!box) return;
  box.replaceChildren();
  const info = getCurrentTrackInfo();
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
  const ids = playableQueue();
  const list = $("upNextList");
  if (list) list.replaceChildren(...ids.map((id, i) => queueRow(id, i + 1)));

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
  const next = $("t-next");
  if (next) next.disabled = empty;
  renderNowPlaying();
  document.dispatchEvent(new CustomEvent("upnext:change", { detail: { count: ids.length } }));
}

/** Songs queued before the stored list arrived stay queued, after it. */
async function restoreQueue() {
  const stored = await readStoredQueue();
  queue = [...stored, ...queue.filter((id) => !stored.includes(id))];
  renderUpNext();
}

export function initUpNext() {
  $("upNextClear")?.addEventListener("click", clearUpNext);
  $("t-next")?.addEventListener("click", playNextInUpNext);
  document.addEventListener("upnext:add", onAddRequest);
  document.addEventListener("trackended", onTrackEnded);
  document.addEventListener("playbackready", onPlaybackReady);
  document.addEventListener("trackopen", renderUpNext);
  onLanguageChange(renderUpNext);
  renderUpNext();
  restoreQueue().catch(console.error);
}
