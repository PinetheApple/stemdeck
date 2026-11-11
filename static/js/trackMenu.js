// A library row's … menu: add the song to a setlist, or rename it.
// catalog.js asks for it with a "trackmenu" event, since this module imports it.

import { addSongToSetlist, createSetlistFrom, getSetlists } from "./setlists.js";
import { startRowRename } from "./songRename.js";
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

function buildMenu(trackId) {
  const el = document.createElement("div");
  el.className = "lib-menu";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", t("trackMenu.open"));
  el.append(
    menuItem(t("trackMenu.rename"), "pencil", function onRenameSong() {
      startRowRename(trackId);
    }),
    menuLabel(t("trackMenu.addToSetlist")),
    ...getSetlists().map((setlist) => setlistItem(setlist, trackId)),
    menuItem(t("trackMenu.newSetlist"), "plus", function onNewSetlistWithSong() {
      createSetlistFrom([trackId]);
    }),
  );
  el.addEventListener("keydown", onMenuKeydown);
  return el;
}

const ROW_SELECTOR = ".cat-item";

/** Beside the row, top edges level, so the menu covers none of the list;
 *  under the row when the window has no room beside it. */
function placeMenu(el, anchor) {
  const row = (anchor.closest(ROW_SELECTOR) ?? anchor).getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  const besideLeft = row.right + MENU_GAP_PX;
  const fitsBeside = besideLeft + width <= window.innerWidth - VIEWPORT_MARGIN_PX;
  const left = fitsBeside ? besideLeft : Math.min(row.right - width, window.innerWidth - width - VIEWPORT_MARGIN_PX);
  const top = fitsBeside ? row.top : row.bottom + MENU_GAP_PX;
  const lowest = window.innerHeight - height - VIEWPORT_MARGIN_PX;
  el.style.left = `${Math.max(VIEWPORT_MARGIN_PX, left)}px`;
  el.style.top = `${Math.max(VIEWPORT_MARGIN_PX, Math.min(top, lowest))}px`;
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

function onTrackMenuRequest(e) {
  const { id, anchor } = e.detail || {};
  const reopening = menu && anchorEl === anchor;
  closeMenu();
  if (!id || !anchor || reopening) return;
  menu = buildMenu(id);
  anchorEl = anchor;
  anchor.setAttribute("aria-expanded", "true");
  document.body.append(menu);
  placeMenu(menu, anchor);
  focusableItems()[0]?.focus();
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  window.addEventListener("resize", closeMenu);
}

export function initTrackMenu() {
  document.addEventListener("trackmenu", onTrackMenuRequest);
  document.getElementById("catalogList")?.addEventListener("scroll", closeMenu, { passive: true });
}
