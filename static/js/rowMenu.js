// The studio's small menus (recording tracks, stem lanes): one open at a time, under
// its button, or over it when the footer leaves no room below.

import { icon } from "./libraryIcons.js";

const MENU_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;
const ITEM_CLASS = "lib-menu-item";
const DANGER_CLASS = "is-danger";
const HINT_CLASS = "row-menu-hint";

let menu = null;
let anchorEl = null;
let anchorRect = null;

function textSpan(text, className = "") {
  const span = document.createElement("span");
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

function plainButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  return btn;
}

/** An entry's element: its own `link` when it has one, else a button. */
function entryEl(item) {
  const el = item.link ?? plainButton();
  el.classList.add(ITEM_CLASS);
  if (item.danger) el.classList.add(DANGER_CLASS);
  el.innerHTML = item.iconHtml ?? icon(item.icon);
  el.append(textSpan(item.text));
  if (item.hint) el.append(textSpan(item.hint, HINT_CLASS));
  if (item.title) el.title = item.title;
  return el;
}

function separatorEl() {
  const sep = document.createElement("div");
  sep.className = "lib-menu-sep";
  sep.setAttribute("role", "separator");
  return sep;
}

/**
 * A menu entry: `{ text, icon | iconHtml, onChoose | link, hint?, danger?, selected?, disabled?, title? }`,
 * or `{ separator: true }`. A `link` is an anchor that does its own thing when clicked.
 */
function itemEl(item) {
  if (item.separator) return separatorEl();
  const el = entryEl(item);
  el.setAttribute("role", item.selected === undefined ? "menuitem" : "menuitemradio");
  if (item.selected !== undefined) el.setAttribute("aria-checked", String(item.selected));
  if (item.disabled) {
    el.disabled = true;
    return el;
  }
  if (item.link) {
    el.addEventListener("click", closeRowMenu);
    return el;
  }
  el.addEventListener("click", function onRowMenuChoose(e) {
    e.stopPropagation();
    closeRowMenu();
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
  return [...(menu?.querySelectorAll(`.${ITEM_CLASS}:not(:disabled)`) ?? [])];
}

function onMenuKeydown(e) {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    const anchor = anchorEl;
    closeRowMenu();
    anchor?.focus({ preventScroll: true });
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const list = items();
  const at = list.indexOf(document.activeElement);
  list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus({ preventScroll: true });
}

function onOutsidePointerDown(e) {
  if (menu && !menu.contains(e.target) && !anchorEl?.contains(e.target)) closeRowMenu();
}

// Any scroll that carries the button away; the waves scrolling sideways under it does not.
function onAnyScroll() {
  const now = anchorEl?.getBoundingClientRect();
  if (now && (now.top !== anchorRect.top || now.left !== anchorRect.left)) closeRowMenu();
}

export function closeRowMenu() {
  if (!menu) return;
  menu.remove();
  menu = null;
  anchorEl?.setAttribute("aria-expanded", "false");
  anchorEl = null;
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  document.removeEventListener("scroll", onAnyScroll, true);
  window.removeEventListener("resize", closeRowMenu);
}

/** Toggle a menu of `entries` under `anchor`. */
export function openRowMenu(anchor, label, entries, { alignRight = false } = {}) {
  const reopening = menu && anchorEl === anchor;
  closeRowMenu();
  if (reopening) return;
  menu = document.createElement("div");
  menu.className = "lib-menu rec-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  menu.append(...entries.map(itemEl));
  menu.addEventListener("keydown", onMenuKeydown);
  anchorEl = anchor;
  anchorRect = anchor.getBoundingClientRect();
  anchor.setAttribute("aria-expanded", "true");
  document.body.append(menu);
  place(menu, anchor, alignRight);
  items()[0]?.focus({ preventScroll: true });
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("scroll", onAnyScroll, { capture: true, passive: true });
  window.addEventListener("resize", closeRowMenu);
}
