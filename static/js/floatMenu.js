// The library's menus: items, separators and headings in a popup that stays in
// the window, opened beside a row, under a button or at the pointer.
// Up/Down/Home/End move through the enabled items; Esc closes it back on its opener.

import { iconButton } from "./libraryControls.js";
import { FLOAT_CLASS } from "./shellFloat.js";

const MENU_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;
const ROW_SELECTOR = ".cat-item, .cat-version";
const ENABLED_ITEMS = ".lib-menu-item:not(:disabled)";
// Indents a subfolder under its parent, as the folder tree does.
const DEPTH_PROPERTY = "--menu-depth";
const STEP_KEYS = Object.freeze({ ArrowDown: 1, ArrowUp: -1 });
const JUMP_KEYS = new Set(["Home", "End"]);

let menu = null;
let anchorEl = null;

/** `keep` leaves the menu open and hands the item to `onChoose`, for an item that asks twice. */
export function menuItem(text, iconName, onChoose, { disabled = false, keep = false, depth = null } = {}) {
  const item = iconButton("lib-menu-item", iconName, { text });
  item.setAttribute("role", "menuitem");
  item.disabled = disabled;
  if (depth !== null) {
    item.classList.add("lib-menu-folder");
    item.style.setProperty(DEPTH_PROPERTY, String(depth));
  }
  item.addEventListener("click", function onMenuItemClick(e) {
    e.stopPropagation();
    if (!keep) closeMenu();
    onChoose(item);
  });
  return item;
}

export function menuSeparator() {
  const sep = document.createElement("div");
  sep.className = "lib-menu-sep";
  sep.setAttribute("role", "separator");
  return sep;
}

export function menuLabel(text) {
  const label = document.createElement("div");
  label.className = "lib-menu-label";
  label.textContent = text;
  return label;
}

const lowestTop = (height) => window.innerHeight - height - VIEWPORT_MARGIN_PX;
const rightmostLeft = (width) => window.innerWidth - width - VIEWPORT_MARGIN_PX;

function setPosition(el, left, top) {
  el.style.left = `${Math.round(Math.max(VIEWPORT_MARGIN_PX, left))}px`;
  el.style.top = `${Math.round(Math.max(VIEWPORT_MARGIN_PX, top))}px`;
}

/** Above the row, or under it when the window has no room above; held inside the window when neither fits. */
function topOffRow(row, height) {
  const above = row.top - MENU_GAP_PX - height;
  if (above >= VIEWPORT_MARGIN_PX) return above;
  return Math.min(row.bottom + MENU_GAP_PX, lowestTop(height));
}

/** Beside the row, top edges level, so the menu covers none of the list;
 *  above or below the row when the window has no room beside it. */
export function placeBeside(el, anchor) {
  const row = (anchor.closest(ROW_SELECTOR) ?? anchor).getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  const besideLeft = row.right + MENU_GAP_PX;
  const fitsBeside = besideLeft + width <= window.innerWidth - VIEWPORT_MARGIN_PX;
  const left = fitsBeside ? besideLeft : Math.min(row.right - width, rightmostLeft(width));
  setPosition(el, left, fitsBeside ? Math.min(row.top, lowestTop(height)) : topOffRow(row, height));
}

/** Under the anchor, left edges level, inside the window. */
export function placeBelow(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  setPosition(el, Math.min(rect.left, rightmostLeft(width)), Math.min(rect.bottom + MENU_GAP_PX, lowestTop(height)));
}

/** At the pointer, opening left or up where the window has no room right or below. */
export function placeAtPoint({ x, y }) {
  return function placeAtPointer(el) {
    const { width, height } = el.getBoundingClientRect();
    const left = x + width > window.innerWidth - VIEWPORT_MARGIN_PX ? x - width : x;
    const top = y + height > window.innerHeight - VIEWPORT_MARGIN_PX ? y - height : y;
    setPosition(el, Math.min(left, rightmostLeft(width)), Math.min(top, lowestTop(height)));
  };
}

function enabledItems() {
  return [...(menu?.querySelectorAll(ENABLED_ITEMS) ?? [])];
}

function focusItem(item) {
  item?.focus();
}

function moveFocus(key) {
  const items = enabledItems();
  if (JUMP_KEYS.has(key)) {
    focusItem(key === "Home" ? items[0] : items.at(-1));
    return;
  }
  const at = items.indexOf(document.activeElement);
  focusItem(items[(at + STEP_KEYS[key] + items.length) % items.length]);
}

function onMenuKeydown(e) {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    const anchor = anchorEl;
    closeMenu();
    anchor?.focus({ preventScroll: true });
    return;
  }
  if (!(e.key in STEP_KEYS) && !JUMP_KEYS.has(e.key)) return;
  e.preventDefault();
  moveFocus(e.key);
}

function onOutsidePointerDown(e) {
  // The … button itself toggles the menu on its click.
  if (menu && !menu.contains(e.target) && !anchorEl?.contains(e.target)) closeMenu();
}

// A list scrolled under the menu moves the row it was opened from.
function onPageScroll(e) {
  if (menu && !menu.contains(e.target)) closeMenu();
}

const opensPopup = (el) => el.hasAttribute("aria-haspopup");

export function closeMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  if (opensPopup(anchorEl)) anchorEl.setAttribute("aria-expanded", "false");
  anchorEl = null;
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  document.removeEventListener("scroll", onPageScroll, true);
  window.removeEventListener("resize", closeMenu);
}

function listenWhileOpen() {
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("scroll", onPageScroll, { capture: true, passive: true });
  window.addEventListener("resize", closeMenu);
}

/**
 * Open a menu of `items` from `anchor`, or close it when it is already open from there
 * and `toggle` is on. `place(menu, anchor)` positions it; `className` is added to it.
 */
export function openMenu(anchor, items, { label, place = placeBeside, className = "", toggle = true }) {
  const reopening = menu && anchorEl === anchor;
  closeMenu();
  if (reopening && toggle) return;
  menu = document.createElement("div");
  menu.className = ["lib-menu", FLOAT_CLASS, className].filter(Boolean).join(" ");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  menu.append(...items);
  menu.addEventListener("keydown", onMenuKeydown);
  anchorEl = anchor;
  if (opensPopup(anchor)) anchor.setAttribute("aria-expanded", "true");
  document.body.append(menu);
  place(menu, anchor);
  enabledItems()[0]?.focus({ preventScroll: true });
  listenWhileOpen();
}
