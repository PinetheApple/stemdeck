// The sidebar's groups and Trash count; collapsed, a strip of the same songs' covers.

import { t, onLanguageChange } from "./i18n.js";
import {
  displayTitle, getLibraryTrack, getPlayingTrackInfo, isInTrash, isPlayableTrack, libraryTrackIds, onLibraryDraw,
  trashTrackIds,
} from "./catalog.js";
import { trashWithUndo } from "./trashUndo.js";
import { SONG_MENU_ATTR } from "./songMenu.js";
import { getQueueSnapshot, onQueueChange, runningLabel } from "./queue.js";
import { openSong } from "./openSong.js";
import { songRowEl } from "./songRow.js";
import { paintOpenVersion, versionExtras } from "./versions.js";
import { esc, thumbHtml } from "./songRowParts.js";
import { wireDropTarget, wireTrackDrag } from "./songDrag.js";
import { wireSongList } from "./libraryRows.js";
import { onRecentlyPlayedChange, readRecentlyPlayed, recentIds, recordPlayed } from "./recentlyPlayed.js";
import { initPlayState, onPlayStateChange } from "./playState.js";
import { openBrowse } from "./browseLibrary.js";
import { drawSidebarSetlists, initSidebarSetlists } from "./sidebarSetlists.js";
import { $ } from "./utils.js";

const RECENT_ROWS = 4;
const BADGE_MAX = 99;
const HIDDEN_CLASS = "hidden";
const STRIP_ACTIVE = "active";
const VIEW = Object.freeze({ QUEUE: "queue", FAVORITES: "fav", RECENT: "recent", TRASH: "trash", ALL: "all" });

let songRows = null;
let importingKey = "";

function emptyNote(text) {
  const note = document.createElement("p");
  note.className = "sidebar-empty";
  note.textContent = text;
  return note;
}

function fillGroup(groupId, ids, emptyText = "") {
  const list = $(groupId)?.querySelector(".sidebar-group-list");
  if (!list) return;
  const rows = ids.flatMap((id) => {
    const row = songRowEl(id);
    return row ? [row, ...versionExtras(id)] : [];
  });
  list.replaceChildren(...(rows.length || !emptyText ? rows : [emptyNote(emptyText)]));
}

/** Favorites, newest first, and the playing song when it is not one of them. */
function favoriteIds() {
  const ids = libraryTrackIds().filter((id) => getLibraryTrack(id).favorite);
  const playing = getPlayingTrackInfo()?.id;
  return playing && !ids.includes(playing) && !isInTrash(playing) ? [...ids, playing] : ids;
}

/** The last songs played, then the newest playable ones, none listed above. */
function recentRowIds(shown) {
  const listed = (id) => Boolean(getLibraryTrack(id)) && !isInTrash(id) && !shown.has(id);
  const played = recentIds(readRecentlyPlayed(), { isListed: listed, limit: RECENT_ROWS });
  const fill = libraryTrackIds().filter((id) => isPlayableTrack(id) && listed(id) && !played.includes(id));
  return [...played, ...fill].slice(0, RECENT_ROWS);
}

function queueJobs(snap = getQueueSnapshot()) {
  return [...(snap?.running ? [snap.running] : []), ...(snap?.queued ?? [])];
}

function importingRowEl(job, running) {
  const track = getLibraryTrack(job.job_id);
  const row = document.createElement("button");
  row.type = "button";
  row.className = "importing-row";
  row.dataset.id = job.job_id;
  row.setAttribute(SONG_MENU_ATTR, "");
  const title = displayTitle(job.title || track?.title || job.source_url);
  const status = running ? runningLabel(job) : t("lib.waiting");
  row.innerHTML = `<span class="cat-thumb">${thumbHtml(track ?? { thumb: job.thumbnail })}</span>
    <span class="cat-meta"><span class="cat-title">${esc(title)}</span><span class="cat-sub">${esc(status)}</span></span>`;
  row.addEventListener("click", onSeeQueueClick);
  return row;
}

function drawImporting(snap = getQueueSnapshot()) {
  const group = $("sidebarImporting");
  if (!group) return;
  const jobs = queueJobs(snap);
  const key = jobs.map((job) => `${job.job_id}:${job.status}:${job.title ?? ""}`).join("|");
  group.hidden = !jobs.length;
  if (key === importingKey) return;
  importingKey = key;
  group.querySelector(".sidebar-group-list")?.replaceChildren(
    ...jobs.map((job) => importingRowEl(job, job === snap?.running)),
  );
}

function paintTrashButton() {
  const count = trashTrackIds().length;
  const badge = $("trashBadge");
  if (badge) {
    badge.textContent = count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
    badge.classList.toggle(HIDDEN_CLASS, count === 0);
  }
  const label = count ? t("nav.trashWithCount", { count }) : t("nav.trash");
  for (const btn of [$("trashBtn"), document.querySelector(".strip-nav-trash")]) {
    btn?.setAttribute("title", label);
    btn?.setAttribute("aria-label", label);
  }
}

function stripThumbEl(trackId) {
  const track = getLibraryTrack(trackId);
  const item = document.createElement("div");
  item.className = trackId === getPlayingTrackInfo()?.id ? `strip-thumb ${STRIP_ACTIVE}` : "strip-thumb";
  item.dataset.id = trackId;
  item.title = displayTitle(track.title);
  item.innerHTML = thumbHtml(track);
  wireTrackDrag(item, trackId);
  item.addEventListener("click", onStripThumbClick);
  return item;
}

// The strip has no selection to make, so a click opens the song.
function onStripThumbClick(e) {
  openSong(e.currentTarget.dataset.id);
}

function drawSongs() {
  const favorites = favoriteIds();
  const recent = recentRowIds(new Set(favorites));
  fillGroup("sidebarFavorites", favorites, t("favorites.emptyHint"));
  fillGroup("sidebarRecent", recent);
  $("catalogStrip")?.replaceChildren(...[...favorites, ...recent].map(stripThumbEl));
}

function drawSidebar() {
  const saved = songRows?.remember();
  drawSongs();
  drawSidebarSetlists();
  drawImporting();
  paintTrashButton();
  // A redraw outside the library's own (a play or pause) still marks the open version.
  paintOpenVersion(getPlayingTrackInfo()?.id);
  songRows?.restore(saved);
}

function onSeeQueueClick() {
  openBrowse(VIEW.QUEUE);
}

function onBrowseClick() {
  openBrowse(VIEW.ALL);
}

function onTrashClick() {
  openBrowse(VIEW.TRASH);
}

function onSeeAllClick(e) {
  openBrowse(e.currentTarget.dataset.view);
}

// A play is recorded, which redraws; a pause only redraws.
function onPlayStateChanged({ id, playing }) {
  if (playing) recordPlayed(id);
  else drawSidebar();
}

function wireSidebarButtons() {
  $("browseBtn")?.addEventListener("click", onBrowseClick);
  document.querySelector(".strip-nav-browse")?.addEventListener("click", onBrowseClick);
  for (const btn of document.querySelectorAll(".sidebar-see-all")) btn.addEventListener("click", onSeeAllClick);
  for (const btn of [$("trashBtn"), document.querySelector(".strip-nav-trash")].filter(Boolean)) {
    btn.addEventListener("click", onTrashClick);
    wireDropTarget(btn, trashWithUndo);
  }
}

export function initSidebar() {
  const list = $("catalogList");
  if (list) songRows = wireSongList(list);
  wireSidebarButtons();
  initSidebarSetlists();
  initPlayState();
  onPlayStateChange(onPlayStateChanged);
  onRecentlyPlayedChange(drawSidebar);
  onLibraryDraw(drawSidebar);
  onQueueChange(drawImporting);
  onLanguageChange(drawSidebar);
  drawSidebar();
}

