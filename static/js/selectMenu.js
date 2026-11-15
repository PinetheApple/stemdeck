// The system list a <select> opens ignores the theme, so only that popup is
// replaced; the select stays the source of truth the app reads and writes.

import {
  edgeIndex,
  isClippedOut,
  pageIndex,
  placeList,
  stepIndex,
  typeaheadIndex,
} from "./selectMenuLogic.js";

const LIST_ID = "select-menu-list";
const OPTION_ID_PREFIX = "select-menu-option-";
const LIST_CLASS = "select-menu";
const OPTION_CLASS = "select-menu-option";
const ACTIVE_CLASS = "active";
const MARGIN_PROPERTY = "--select-menu-margin";
const GAP_PROPERTY = "--select-menu-gap";
const TYPEAHEAD_RESET_MS = 500;
const PAGE_SIZE = 10;
const PRIMARY_BUTTON = 0;
const CLIPPING_OVERFLOW = /auto|scroll|hidden|clip/;
const KEY = Object.freeze({
  DOWN: "ArrowDown",
  UP: "ArrowUp",
  HOME: "Home",
  END: "End",
  PAGE_DOWN: "PageDown",
  PAGE_UP: "PageUp",
  ENTER: "Enter",
  SPACE: " ",
  ESCAPE: "Escape",
  TAB: "Tab",
  F4: "F4",
});
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
const isVertical = (key) => key === KEY.DOWN || key === KEY.UP;
const isEdge = (key) => key === KEY.HOME || key === KEY.END;
const isPage = (key) => key === KEY.PAGE_DOWN || key === KEY.PAGE_UP;
const layoutKey = (r) => [r.top, r.left, r.width, r.height, window.innerWidth, window.innerHeight].join();

function optionRow(option, index) {
  const row = document.createElement("div");
  row.className = OPTION_CLASS;
  row.id = `${OPTION_ID_PREFIX}${index}`;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", String(option.selected));
  if (option.disabled) row.setAttribute("aria-disabled", "true");
  row.dataset.index = String(index);
  row.textContent = option.label;
  return row;
}

function renderOptions() {
  const { select, list } = menu;
  menu.signature = optionsSignature(select);
  menu.selected = select.selectedIndex;
  list.replaceChildren(...[...select.options].map(optionRow));
}

function setActive(index) {
  menu.active = index;
  for (const row of menu.list.children) {
    row.classList.toggle(ACTIVE_CLASS, row.dataset.index === String(index));
  }
  const row = menu.list.children[index];
  if (!row) {
    menu.list.removeAttribute("aria-activedescendant");
    return;
  }
  menu.list.setAttribute("aria-activedescendant", row.id);
  revealRow(row);
}

function revealRow(row) {
  const { list } = menu;
  if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  const rowBottom = row.offsetTop + row.offsetHeight;
  if (rowBottom > list.scrollTop + list.clientHeight) list.scrollTop = rowBottom - list.clientHeight;
}

function showSelected() {
  const { select, list } = menu;
  menu.selected = select.selectedIndex;
  for (const row of list.children) {
    row.setAttribute("aria-selected", String(row.dataset.index === String(menu.selected)));
  }
  if (!select.options[menu.selected]?.disabled) setActive(menu.selected);
}

const cssPx = (el, property) => parseFloat(getComputedStyle(el).getPropertyValue(property)) || 0;

function positionList(anchor = menu.select.getBoundingClientRect()) {
  const { list } = menu;
  menu.layout = layoutKey(anchor);
  list.style.minWidth = `${anchor.width}px`;
  list.style.maxHeight = "";
  const place = placeList({
    anchor,
    listWidth: list.offsetWidth,
    listHeight: list.scrollHeight,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    gap: cssPx(list, GAP_PROPERTY),
    margin: cssPx(list, MARGIN_PROPERTY),
  });
  list.style.top = `${place.top}px`;
  list.style.left = `${place.left}px`;
  list.style.maxHeight = `${place.maxHeight}px`;
}

function buildList(select) {
  const list = document.createElement("div");
  list.className = LIST_CLASS;
  list.id = LIST_ID;
  list.tabIndex = -1;
  list.setAttribute("role", "listbox");
  const name = select.getAttribute("aria-label") || select.labels?.[0]?.textContent?.trim();
  if (name) list.setAttribute("aria-label", name);
  const field = getComputedStyle(select);
  list.style.fontFamily = field.fontFamily;
  list.style.fontSize = field.fontSize;
  if ("showPopover" in list) list.popover = "manual";
  list.addEventListener("mousedown", onListMousedown);
  list.addEventListener("mouseover", onListMouseover);
  list.addEventListener("click", onListClick);
  list.addEventListener("focusout", onListFocusout);
  return list;
}

function clippingAncestors(select) {
  const found = [];
  for (let el = select.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (CLIPPING_OVERFLOW.test(`${style.overflowX} ${style.overflowY}`)) found.push(el);
  }
  return found;
}

function openMenu(select, active = select.selectedIndex) {
  if (select.disabled || !select.options.length) return;
  const list = buildList(select);
  // Beside the select, so containers that close on a click outside themselves
  // count a click in the list as inside; the top layer keeps it unclipped.
  select.after(list);
  const observer = new MutationObserver(onOptionsChanged);
  menu = { select, list, observer, active: -1, clippers: clippingAncestors(select) };
  renderOptions();
  list.showPopover?.();
  positionList();
  select.setAttribute("aria-haspopup", "listbox");
  select.setAttribute("aria-expanded", "true");
  select.setAttribute("aria-controls", LIST_ID);
  const usable = active >= 0 && !select.options[active]?.disabled;
  setActive(usable ? active : edgeIndex(optionFlags(select), false));
  list.focus({ preventScroll: true });
  observer.observe(select, WATCHED_OPTION_CHANGES);
  menu.frame = requestAnimationFrame(followSelect);
}

/** Closes the list, handing focus back to the select if the list held it. */
function closeMenu({ refocus = true } = {}) {
  if (!menu) return;
  const { select, list, observer, frame } = menu;
  menu = null;
  observer.disconnect();
  cancelAnimationFrame(frame);
  select.setAttribute("aria-expanded", "false");
  select.removeAttribute("aria-controls");
  if (refocus && select.isConnected && list.contains(document.activeElement)) {
    select.focus({ preventScroll: true });
  }
  list.remove();
}

/** Keeps the open list in step with its select, whatever moved or changed it. */
function followSelect() {
  if (!menu) return;
  const { select } = menu;
  if (!select.isConnected || select.disabled) {
    closeMenu({ refocus: false });
    return;
  }
  const anchor = select.getBoundingClientRect();
  const clips = [viewportRect(), ...menu.clippers.map((el) => el.getBoundingClientRect())];
  if (isClippedOut(anchor, clips)) {
    closeMenu();
    return;
  }
  if (select.selectedIndex !== menu.selected) showSelected();
  if (layoutKey(anchor) !== menu.layout) positionList(anchor);
  menu.frame = requestAnimationFrame(followSelect);
}

const viewportRect = () => ({ top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth });

function commit(select, index) {
  if (index < 0 || select.options[index]?.disabled || index === select.selectedIndex) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function choose(index) {
  const { select } = menu;
  closeMenu();
  commit(select, index);
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
const isTypingSpace = () => performance.now() - typedAt <= TYPEAHEAD_RESET_MS;

/** A key on a closed select: true when handled. Letters are left to the
 * select's own type-ahead. */
function keyOnClosedSelect(select, e) {
  if (e.ctrlKey || e.metaKey) return false;
  const flags = optionFlags(select);
  if (e.key === KEY.ENTER || e.key === KEY.SPACE || e.key === KEY.F4 || (e.altKey && isVertical(e.key))) {
    openMenu(select);
  } else if (isVertical(e.key)) {
    commit(select, stepIndex(flags, select.selectedIndex, e.key === KEY.DOWN ? 1 : -1));
  } else if (isEdge(e.key)) {
    commit(select, edgeIndex(flags, e.key === KEY.END));
  } else {
    return false;
  }
  return true;
}

/** A key while the list is open: true when the list handled it. */
function keyInList(e) {
  const flags = optionFlags(menu.select);
  const step = e.key === KEY.DOWN || e.key === KEY.PAGE_DOWN ? 1 : -1;
  if (e.key === KEY.ESCAPE) {
    closeMenu();
  } else if (e.key === KEY.TAB) {
    choose(menu.active);
    return false;
  } else if (e.key === KEY.F4 || (e.altKey && e.key === KEY.UP)) {
    choose(menu.active);
  } else if (isVertical(e.key)) {
    setActive(stepIndex(flags, menu.active, step));
  } else if (isPage(e.key)) {
    setActive(pageIndex(flags, menu.active, step, PAGE_SIZE));
  } else if (isEdge(e.key)) {
    setActive(edgeIndex(flags, e.key === KEY.END));
  } else if (isTypingKey(e) && (e.key !== KEY.SPACE || isTypingSpace())) {
    typeahead(e.key);
  } else if (e.key === KEY.ENTER || e.key === KEY.SPACE) {
    choose(menu.active);
  } else {
    return false;
  }
  return true;
}

function onKeydown(e) {
  let handled = false;
  if (menu?.list.contains(e.target)) handled = keyInList(e);
  else if (isSingleSelect(e.target)) handled = keyOnClosedSelect(e.target, e);
  if (!handled) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}

function onPressOutside(e) {
  if (!menu || menu.list.contains(e.target) || e.target === menu.select) return;
  closeMenu({ refocus: false });
}

/** Bubbling, so a press help mode has already taken never opens the list. */
function onSelectPress(e) {
  const select = e.target;
  if (!isSingleSelect(select) || e.button !== PRIMARY_BUTTON || e.defaultPrevented) return;
  e.preventDefault();
  if (menu?.select === select) closeMenu();
  else openMenu(select);
}

function onOptionsChanged() {
  if (!menu || optionsSignature(menu.select) === menu.signature) return;
  const { select } = menu;
  if (!select.options.length) {
    closeMenu();
    return;
  }
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

function onListFocusout(e) {
  if (menu && !menu.list.contains(e.relatedTarget)) closeMenu({ refocus: false });
}

// On window capture, ahead of help mode's listener; Sync lines listens earlier
// but stands down while a control reports an open popup (aria-haspopup/expanded).
window.addEventListener("keydown", onKeydown, true);
document.addEventListener("mousedown", onPressOutside, true);
document.addEventListener("mousedown", onSelectPress);
