// Every single-choice <select> opens a styled list instead of the browser's
// own. The select stays focused and stays the source of truth: its value,
// change events and options are the ones the rest of the app reads and writes.
// The list is built from the options each time it opens, so selects created or
// rebuilt later need nothing extra.

import { edgeIndex, placeList, stepIndex, typeaheadIndex } from "./selectMenuLogic.js";

const LIST_ID = "select-menu-list";
const OPTION_ID_PREFIX = "select-menu-option-";
const LIST_CLASS = "select-menu";
const OPTION_CLASS = "select-menu-option";
const ACTIVE_CLASS = "active";
const LIST_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;
const TYPEAHEAD_RESET_MS = 500;
const PRIMARY_BUTTON = 0;
const SPACE = " ";
const OPENING_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", SPACE, "F4"]);
const WATCHED_OPTION_CHANGES = {
  childList: true,
  subtree: true,
  characterData: true,
  attributes: true,
  attributeFilter: ["disabled", "label"],
};

let menu = null;
let typed = "";
let typedAt = 0;

const isSingleSelect = (el) => el instanceof HTMLSelectElement && !el.multiple && el.size <= 1;
const optionFlags = (select) => [...select.options].map((o) => o.disabled);
const optionLabels = (select) => [...select.options].map((o) => o.label);
const optionsSignature = (select) => JSON.stringify([optionLabels(select), optionFlags(select)]);

function renderOptions() {
  const { select, list } = menu;
  menu.signature = optionsSignature(select);
  list.replaceChildren(...[...select.options].map(function optionRow(option, index) {
    const row = document.createElement("div");
    row.className = OPTION_CLASS;
    row.id = `${OPTION_ID_PREFIX}${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(option.selected));
    if (option.disabled) row.setAttribute("aria-disabled", "true");
    row.dataset.index = String(index);
    row.textContent = option.label;
    return row;
  }));
}

function setActive(index) {
  menu.active = index;
  for (const row of menu.list.children) row.classList.toggle(ACTIVE_CLASS, row.dataset.index === String(index));
  const row = menu.list.children[index];
  if (!row) {
    menu.select.removeAttribute("aria-activedescendant");
    return;
  }
  menu.select.setAttribute("aria-activedescendant", row.id);
  revealRow(row);
}

function revealRow(row) {
  const { list } = menu;
  if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  const rowBottom = row.offsetTop + row.offsetHeight;
  if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight;
}

function positionList() {
  const { select, list } = menu;
  const anchor = select.getBoundingClientRect();
  list.style.minWidth = `${anchor.width}px`;
  list.style.maxHeight = "";
  const place = placeList({
    anchor,
    listWidth: list.offsetWidth,
    listHeight: list.scrollHeight,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    gap: LIST_GAP_PX,
    margin: VIEWPORT_MARGIN_PX,
  });
  list.style.top = `${place.top}px`;
  list.style.left = `${place.left}px`;
  list.style.maxHeight = `${place.maxHeight}px`;
  list.classList.toggle("flipped", place.flipped);
}

function buildList(select) {
  const list = document.createElement("div");
  list.className = LIST_CLASS;
  list.id = LIST_ID;
  list.setAttribute("role", "listbox");
  const name = select.getAttribute("aria-label") || select.labels?.[0]?.textContent?.trim();
  if (name) list.setAttribute("aria-label", name);
  if ("showPopover" in list) list.popover = "manual";
  list.addEventListener("mousedown", onListMousedown);
  list.addEventListener("mouseover", onListMouseover);
  list.addEventListener("click", onListClick);
  return list;
}

function openMenu(select, active = select.selectedIndex) {
  if (select.disabled || !select.options.length) return;
  const list = buildList(select);
  // Beside the select, so containers that close on a click outside themselves
  // count a click in the list as inside; the top layer keeps it unclipped.
  select.after(list);
  menu = { select, list, active: -1, observer: new MutationObserver(onOptionsChanged) };
  renderOptions();
  list.showPopover?.();
  positionList();
  select.setAttribute("aria-expanded", "true");
  select.setAttribute("aria-controls", LIST_ID);
  const usable = active >= 0 && !select.options[active]?.disabled;
  setActive(usable ? active : edgeIndex(optionFlags(select), false));
  menu.observer.observe(select, WATCHED_OPTION_CHANGES);
  window.addEventListener("resize", positionList);
  document.addEventListener("scroll", onScroll, true);
}

function closeMenu() {
  if (!menu) return;
  const { select, list, observer } = menu;
  menu = null;
  observer.disconnect();
  window.removeEventListener("resize", positionList);
  document.removeEventListener("scroll", onScroll, true);
  list.remove();
  select.setAttribute("aria-expanded", "false");
  select.removeAttribute("aria-controls");
  select.removeAttribute("aria-activedescendant");
}

function choose(index) {
  const { select } = menu;
  closeMenu();
  if (index < 0 || select.options[index]?.disabled || index === select.selectedIndex) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function typeahead(key) {
  const now = performance.now();
  typed = now - typedAt > TYPEAHEAD_RESET_MS ? key : typed + key;
  typedAt = now;
  const { select, active } = menu;
  const match = typeaheadIndex(optionLabels(select), optionFlags(select), typed, active);
  if (match >= 0) setActive(match);
}

const isTypingKey = (e) => e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
const isTypingSpace = (e) => e.key === SPACE && performance.now() - typedAt <= TYPEAHEAD_RESET_MS;

/** A key on a closed select: true when it opened the list. */
function openFromKey(select, e) {
  if (e.key === "Home" || e.key === "End") {
    openMenu(select, edgeIndex(optionFlags(select), e.key === "End"));
  } else if (OPENING_KEYS.has(e.key) && !isTypingSpace(e)) {
    openMenu(select);
  } else if (isTypingKey(e)) {
    openMenu(select);
    if (menu) typeahead(e.key);
  } else {
    return false;
  }
  return true;
}

/** A key while the list is open: true when the list handled it. */
function navigateFromKey(e) {
  const flags = optionFlags(menu.select);
  if (e.key === "Escape") closeMenu();
  else if (e.key === "Tab") choose(menu.active);
  else if (e.altKey && e.key === "ArrowUp") choose(menu.active);
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    setActive(stepIndex(flags, menu.active, e.key === "ArrowDown" ? 1 : -1));
  }
  else if (e.key === "Home" || e.key === "End") setActive(edgeIndex(flags, e.key === "End"));
  else if (isTypingSpace(e) || (isTypingKey(e) && e.key !== SPACE)) typeahead(e.key);
  else if (e.key === "Enter" || e.key === SPACE) choose(menu.active);
  else return false;
  return e.key !== "Tab";
}

function onKeydown(e) {
  const select = e.target;
  if (!isSingleSelect(select)) return;
  const handled = menu?.select === select ? navigateFromKey(e) : openFromKey(select, e);
  if (!handled) return;
  e.preventDefault();
  e.stopPropagation();
}

function onMousedown(e) {
  if (menu && !menu.list.contains(e.target) && e.target !== menu.select) closeMenu();
  const select = e.target;
  if (!isSingleSelect(select) || e.button !== PRIMARY_BUTTON) return;
  e.preventDefault();
  if (menu?.select === select) {
    closeMenu();
    return;
  }
  select.focus({ preventScroll: true });
  openMenu(select);
}

function onFocusout(e) {
  if (menu && e.target === menu.select) closeMenu();
}

function onScroll(e) {
  if (menu && !menu.list.contains(e.target)) positionList();
}

function onOptionsChanged() {
  if (!menu) return;
  const { select } = menu;
  if (select.disabled || !select.isConnected || !select.options.length) {
    closeMenu();
    return;
  }
  if (optionsSignature(select) === menu.signature) return;
  const activeValue = select.options[menu.active]?.value;
  renderOptions();
  positionList();
  const kept = [...select.options].findIndex((o) => o.value === activeValue && !o.disabled);
  setActive(kept >= 0 ? kept : select.selectedIndex);
}

const rowIndex = (e) => Number(e.target.closest(`.${OPTION_CLASS}`)?.dataset.index ?? -1);

function onListMousedown(e) {
  e.preventDefault();
}

function onListMouseover(e) {
  const index = rowIndex(e);
  if (index >= 0 && !menu.select.options[index]?.disabled) setActive(index);
}

function onListClick(e) {
  const index = rowIndex(e);
  if (index < 0 || menu.select.options[index]?.disabled) return;
  choose(index);
}

document.addEventListener("keydown", onKeydown, true);
document.addEventListener("mousedown", onMousedown, true);
document.addEventListener("focusout", onFocusout, true);
