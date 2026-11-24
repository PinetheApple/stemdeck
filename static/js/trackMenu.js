// A library row's … menu: rename the song, add it to a setlist, or move it to a folder.
// catalog.js asks for it with a "trackmenu" event, since this module imports it.
// The open song's Up Next and More buttons, in the song head and Stage, live here too.

import { addSongToSetlist, createSetlistFrom, getSetlists } from "./setlists.js";
import { startRowRename } from "./songRename.js";
import {
  TRACK_SHOW_EVENT,
  TRASH_CHANGE_EVENT,
  folderChoices,
  getCurrentTrackInfo,
  getPlayingTrackInfo,
  getLibraryTrack,
  isPlayableTrack,
  moveTrackToFolder,
  moveTrackToNewFolder,
} from "./catalog.js";
import { isStageMode, setStageMode } from "./stageMode.js";
import { queueUpNext } from "./upNext.js";
import { t } from "./i18n.js";
import { iconButton } from "./libraryControls.js";
import { missingStems, openVersionOf } from "./versionModel.js";
import { cancelExtract, isExtracting } from "./extractRun.js";
import { revealSongRows } from "./browseLibrary.js";

const MENU_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;

let menu = null;
let anchorEl = null;

export function menuItem(text, iconName, onChoose, { disabled = false } = {}) {
  const item = iconButton("lib-menu-item", iconName, { text });
  item.setAttribute("role", "menuitem");
  item.disabled = disabled;
  item.addEventListener("click", function onMenuItemClick(e) {
    e.stopPropagation();
    closeMenu();
    onChoose();
  });
  return item;
}

export function menuSeparator() {
  const sep = document.createElement("div");
  sep.className = "lib-menu-sep";
  sep.setAttribute("role", "separator");
  return sep;
}

function menuLabel(text) {
  const label = document.createElement("div");
  label.className = "lib-menu-label";
  label.textContent = text;
  return label;
}

function setlistItem(setlist, trackId) {
  const has = setlist.song_ids.includes(trackId);
  return menuItem(setlist.name, has ? "check" : "listMusic", function onAddToSetlist() {
    addSongToSetlist(setlist.id, trackId);
  }, { disabled: has });
}

// Indents a subfolder under its parent, as the folder tree does.
const DEPTH_PROPERTY = "--menu-depth";

function folderItem(folder, trackId, anchor) {
  const item = menuItem(folder.name, folder.current ? "check" : "folder", function onMoveToFolder() {
    if (!moveTrackToFolder(trackId, folder.id)) anchor.focus();
  }, { disabled: folder.current });
  item.classList.add("lib-menu-folder");
  item.style.setProperty(DEPTH_PROPERTY, String(folder.depth));
  if (folder.current) item.setAttribute("aria-current", "true");
  return item;
}

function folderSection(trackId, anchor) {
  return [
    menuLabel(t("trackMenu.moveToFolder")),
    ...folderChoices(trackId).map((folder) => folderItem(folder, trackId, anchor)),
    menuItem(t("trackMenu.newFolder"), "plus", function onNewFolderWithSong() {
      moveTrackToNewFolder(trackId);
    }),
  ];
}

function canExtractMore(trackId) {
  const track = getLibraryTrack(trackId);
  const open = openVersionOf(track);
  return track?.status === "done" && Boolean(open) && missingStems(open.stems).length > 0;
}

/** The song head and Stage offer Extract too, so Browse library and the song's row come on screen first. */
function revealLibraryRow() {
  if (isStageMode()) setStageMode(false);
  revealSongRows();
}

// versions.js draws the form; an event, since it imports this module.
function extractMoreItem(trackId, anchor) {
  return menuItem(t("versions.extractMore"), "plus", function onExtractMoreStems() {
    revealLibraryRow();
    document.dispatchEvent(new CustomEvent("versions:extract", { detail: { id: trackId, anchor } }));
  });
}

function stopExtractItem(trackId) {
  return menuItem(t("versions.extractStop"), "x", function onStopExtracting() {
    cancelExtract(trackId);
  });
}

function extractItems(trackId, anchor) {
  if (isExtracting(trackId)) return [stopExtractItem(trackId)];
  return canExtractMore(trackId) ? [extractMoreItem(trackId, anchor)] : [];
}

/** The open song's menu has no Rename: the song head has its own, and Stage has no row to edit in. */
function renameItems(trackId, rename) {
  if (!rename) return [];
  return [
    menuItem(t("trackMenu.rename"), "pencil", function onRenameSong() {
      startRowRename(trackId);
    }),
  ];
}

function buildMenu(trackId, anchor, { rename }) {
  return [
    ...renameItems(trackId, rename),
    ...extractItems(trackId, anchor),
    menuLabel(t("trackMenu.addToSetlist")),
    ...getSetlists().map((setlist) => setlistItem(setlist, trackId)),
    menuItem(t("trackMenu.newSetlist"), "plus", function onNewSetlistWithSong() {
      createSetlistFrom([trackId]);
    }),
    ...folderSection(trackId, anchor),
  ];
}

const ROW_SELECTOR = ".cat-item, .cat-version";

/** Above the row, or under it when the window has no room above; held inside the window when neither fits. */
function topOffRow(row, height) {
  const above = row.top - MENU_GAP_PX - height;
  if (above >= VIEWPORT_MARGIN_PX) return above;
  const below = row.bottom + MENU_GAP_PX;
  return Math.min(below, window.innerHeight - height - VIEWPORT_MARGIN_PX);
}

/** Beside the row, top edges level, so the menu covers none of the list;
 *  above or below the row when the window has no room beside it. */
function placeMenu(el, anchor) {
  const row = (anchor.closest(ROW_SELECTOR) ?? anchor).getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  const besideLeft = row.right + MENU_GAP_PX;
  const fitsBeside = besideLeft + width <= window.innerWidth - VIEWPORT_MARGIN_PX;
  const left = fitsBeside ? besideLeft : Math.min(row.right - width, window.innerWidth - width - VIEWPORT_MARGIN_PX);
  const lowest = window.innerHeight - height - VIEWPORT_MARGIN_PX;
  const top = fitsBeside ? Math.min(row.top, lowest) : topOffRow(row, height);
  el.style.left = `${Math.max(VIEWPORT_MARGIN_PX, left)}px`;
  el.style.top = `${Math.max(VIEWPORT_MARGIN_PX, top)}px`;
}

/** Under the anchor, left edges level. */
export function placeBelow(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.bottom + MENU_GAP_PX}px`;
}

function focusableItems() {
  return [...(menu?.querySelectorAll(".lib-menu-item:not(:disabled)") ?? [])];
}

function onMenuKeydown(e) {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    const anchor = anchorEl;
    closeMenu();
    anchor?.focus();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = focusableItems();
  const at = items.indexOf(document.activeElement);
  const step = e.key === "ArrowDown" ? 1 : -1;
  items[(at + step + items.length) % items.length]?.focus();
}

function onOutsidePointerDown(e) {
  // The … button itself toggles the menu on its click.
  if (menu && !menu.contains(e.target) && !anchorEl?.contains(e.target)) closeMenu();
}

function closeMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  anchorEl?.setAttribute("aria-expanded", "false");
  anchorEl = null;
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  window.removeEventListener("resize", closeMenu);
}

/** Open a menu of `items` from `anchor`, or close it when it is already open from there. */
export function openMenu(anchor, items, { label, place = placeMenu }) {
  const reopening = menu && anchorEl === anchor;
  closeMenu();
  if (reopening) return;
  menu = document.createElement("div");
  menu.className = "lib-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  menu.append(...items);
  menu.addEventListener("keydown", onMenuKeydown);
  anchorEl = anchor;
  anchor.setAttribute("aria-expanded", "true");
  document.body.append(menu);
  place(menu, anchor);
  focusableItems()[0]?.focus();
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  window.addEventListener("resize", closeMenu);
}

function toggleMenu(id, anchor, { rename = true } = {}) {
  if (!id || !anchor) {
    closeMenu();
    return;
  }
  openMenu(anchor, buildMenu(id, anchor, { rename }), { label: t("trackMenu.open") });
}

function onTrackMenuRequest(e) {
  const { id, anchor } = e.detail || {};
  toggleMenu(id, anchor);
}

const STAGE_UP_NEXT_ID = "stageUpNextBtn";
const STAGE_MORE_ID = "stageMoreBtn";
const OPEN_SONG_UP_NEXT_IDS = ["songUpNextBtn", STAGE_UP_NEXT_ID];
const OPEN_SONG_MORE_IDS = ["songMoreBtn", STAGE_MORE_ID];
// Stage shows the song in the player, which keeps playing while another is shown.
const STAGE_SONG_IDS = new Set([STAGE_UP_NEXT_ID, STAGE_MORE_ID]);

function openSongButtons(ids = [...OPEN_SONG_UP_NEXT_IDS, ...OPEN_SONG_MORE_IDS]) {
  return ids.map((id) => document.getElementById(id)).filter(Boolean);
}

/** The library row's rule: a trashed or unfinished open song is offered to nothing. */
function playableOpenSongId(button) {
  const info = STAGE_SONG_IDS.has(button.id) ? getPlayingTrackInfo() : getCurrentTrackInfo();
  return isPlayableTrack(info?.id) ? info.id : null;
}

function paintOpenSongButtons() {
  for (const button of openSongButtons()) button.disabled = !playableOpenSongId(button);
}

function onAddOpenSongToUpNext(e) {
  const id = playableOpenSongId(e.currentTarget);
  if (id) queueUpNext(id);
}

function onOpenSongMenuClick(e) {
  toggleMenu(playableOpenSongId(e.currentTarget), e.currentTarget, { rename: false });
}

function wireOpenSongButtons() {
  for (const button of openSongButtons(OPEN_SONG_UP_NEXT_IDS)) {
    button.addEventListener("click", onAddOpenSongToUpNext);
  }
  for (const button of openSongButtons(OPEN_SONG_MORE_IDS)) {
    button.addEventListener("click", onOpenSongMenuClick);
  }
  for (const eventName of ["trackopen", TRACK_SHOW_EVENT, "tracknames", TRASH_CHANGE_EVENT]) {
    document.addEventListener(eventName, paintOpenSongButtons);
  }
  paintOpenSongButtons();
}

export function initTrackMenu() {
  document.addEventListener("trackmenu", onTrackMenuRequest);
  for (const id of ["catalogList", "browseResults"]) {
    document.getElementById(id)?.addEventListener("scroll", closeMenu, { passive: true });
  }
  wireOpenSongButtons();
}
