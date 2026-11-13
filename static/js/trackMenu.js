// A library row's … menu: rename the song, add it to a setlist, or move it to a folder.
// catalog.js asks for it with a "trackmenu" event, since this module imports it.
// The open song's Up Next and More buttons, in the song head and Stage, live here too.

import { addSongToSetlist, createSetlistFrom, getSetlists } from "./setlists.js";
import { startRowRename } from "./songRename.js";
import {
  TRASH_CHANGE_EVENT,
  folderChoices,
  getCurrentTrackInfo,
  isPlayableTrack,
  moveTrackToFolder,
  moveTrackToNewFolder,
} from "./catalog.js";
import { queueUpNext } from "./upNext.js";
import { t } from "./i18n.js";
import { iconButton } from "./libraryControls.js";

const MENU_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;

let menu = null;
let anchorEl = null;

function menuItem(text, iconName, onChoose, { disabled = false } = {}) {
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
  const el = document.createElement("div");
  el.className = "lib-menu";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", t("trackMenu.open"));
  el.append(
    ...renameItems(trackId, rename),
    menuLabel(t("trackMenu.addToSetlist")),
    ...getSetlists().map((setlist) => setlistItem(setlist, trackId)),
    menuItem(t("trackMenu.newSetlist"), "plus", function onNewSetlistWithSong() {
      createSetlistFrom([trackId]);
    }),
    ...folderSection(trackId, anchor),
  );
  el.addEventListener("keydown", onMenuKeydown);
  return el;
}

const ROW_SELECTOR = ".cat-item";

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

function toggleMenu(id, anchor, { rename = true } = {}) {
  const reopening = menu && anchorEl === anchor;
  closeMenu();
  if (!id || !anchor || reopening) return;
  menu = buildMenu(id, anchor, { rename });
  anchorEl = anchor;
  anchor.setAttribute("aria-expanded", "true");
  document.body.append(menu);
  placeMenu(menu, anchor);
  focusableItems()[0]?.focus();
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  window.addEventListener("resize", closeMenu);
}

function onTrackMenuRequest(e) {
  const { id, anchor } = e.detail || {};
  toggleMenu(id, anchor);
}

const OPEN_SONG_UP_NEXT_IDS = ["songUpNextBtn", "stageUpNextBtn"];
const OPEN_SONG_MORE_IDS = ["songMoreBtn", "stageMoreBtn"];

function openSongButtons(ids = [...OPEN_SONG_UP_NEXT_IDS, ...OPEN_SONG_MORE_IDS]) {
  return ids.map((id) => document.getElementById(id)).filter(Boolean);
}

/** The library row's rule: a trashed or unfinished open song is offered to nothing. */
function playableOpenSongId() {
  const id = getCurrentTrackInfo()?.id;
  return isPlayableTrack(id) ? id : null;
}

function paintOpenSongButtons() {
  const playable = Boolean(playableOpenSongId());
  for (const button of openSongButtons()) button.disabled = !playable;
}

function onAddOpenSongToUpNext() {
  const id = playableOpenSongId();
  if (id) queueUpNext(id);
}

function onOpenSongMenuClick(e) {
  toggleMenu(playableOpenSongId(), e.currentTarget, { rename: false });
}

function wireOpenSongButtons() {
  for (const button of openSongButtons(OPEN_SONG_UP_NEXT_IDS)) {
    button.addEventListener("click", onAddOpenSongToUpNext);
  }
  for (const button of openSongButtons(OPEN_SONG_MORE_IDS)) {
    button.addEventListener("click", onOpenSongMenuClick);
  }
  for (const eventName of ["trackopen", "tracknames", TRASH_CHANGE_EVENT]) {
    document.addEventListener(eventName, paintOpenSongButtons);
  }
  paintOpenSongButtons();
}

export function initTrackMenu() {
  document.addEventListener("trackmenu", onTrackMenuRequest);
  document.getElementById("catalogList")?.addEventListener("scroll", closeMenu, { passive: true });
  wireOpenSongButtons();
}
