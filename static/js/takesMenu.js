// The small menus of the recording tracks: the add row's kinds, a track's ⋯
// menu and its input picker. One open at a time, placed under its button, or
// over it when the footer leaves no room below.

import { iconButton } from "./libraryControls.js";

const MENU_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;

let menu = null;
let anchorEl = null;

/** A menu entry: `{ text, icon, onChoose, danger?, selected? }`, or `{ separator: true }`. */
function itemEl(item) {
  if (item.separator) {
    const sep = document.createElement("div");
    sep.className = "lib-menu-sep";
    sep.setAttribute("role", "separator");
    return sep;
  }
  const el = iconButton(`lib-menu-item${item.danger ? " is-danger" : ""}`, item.icon, { text: item.text });
  el.setAttribute("role", item.selected === undefined ? "menuitem" : "menuitemradio");
  if (item.selected !== undefined) el.setAttribute("aria-checked", String(item.selected));
  el.addEventListener("click", function onTakesMenuChoose(e) {
    e.stopPropagation();
    closeTakesMenu();
    item.onChoose();
  });
  return el;
}

function place(el, anchor, alignRight) {
  const r = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  const footerTop = document.querySelector(".daw-footer")?.getBoundingClientRect().top ?? window.innerHeight;
  const fitsBelow = r.bottom + MENU_GAP_PX + height <= footerTop - VIEWPORT_MARGIN_PX;
  const left = alignRight ? r.right - width : r.left;
  el.style.left = `${Math.max(VIEWPORT_MARGIN_PX, Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN_PX))}px`;
  el.style.top = `${Math.max(VIEWPORT_MARGIN_PX, fitsBelow ? r.bottom + MENU_GAP_PX : r.top - height - MENU_GAP_PX)}px`;
}

function items() {
  return [...(menu?.querySelectorAll(".lib-menu-item:not(:disabled)") ?? [])];
}

function onMenuKeydown(e) {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    const anchor = anchorEl;
    closeTakesMenu();
    anchor?.focus();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const list = items();
  const at = list.indexOf(document.activeElement);
  list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
}

function onOutsidePointerDown(e) {
  if (menu && !menu.contains(e.target) && !anchorEl?.contains(e.target)) closeTakesMenu();
}

export function closeTakesMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  anchorEl?.setAttribute("aria-expanded", "false");
  anchorEl = null;
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  window.removeEventListener("resize", closeTakesMenu);
}

/** Toggle a menu of `entries` under `anchor`. */
export function openTakesMenu(anchor, label, entries, { alignRight = false } = {}) {
  const reopening = menu && anchorEl === anchor;
  closeTakesMenu();
  if (reopening) return;
  menu = document.createElement("div");
  menu.className = "lib-menu rec-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  menu.append(...entries.map(itemEl));
  menu.addEventListener("keydown", onMenuKeydown);
  anchorEl = anchor;
  anchor.setAttribute("aria-expanded", "true");
  document.body.append(menu);
  place(menu, anchor, alignRight);
  items()[0]?.focus();
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  window.addEventListener("resize", closeTakesMenu);
}
