// Select in Browse library: a click picks a song instead of showing it, Ctrl/Cmd toggles,
// Shift picks a range, and the picked rows wear a frame and a ticked box.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { selectScopeOf, showsMyOrder } from "./libraryArrange.js";
import { libraryView, selection } from "./libraryView.js";
import { wireMyOrderDrop } from "./myOrderDrag.js";
import { SONG_CARD_CLASS } from "./songRow.js";
import { OUT_OF_TAB_ORDER, ROW_PLAY_CLASS } from "./rovingRows.js";

const PICKED_CLASS = "is-picked";
const PICK_BOX_CLASS = "pick-box";
const CHECKBOX_ROLE = "checkbox";
const PICKABLE_ROW = ".cat-item[data-id]:not(.queue-row):not(.cat-version)";
// The row's own buttons keep their jobs while picking.
const NOT_A_PICK = `.cat-actions, .cat-versions-toggle, .import-fail-panel, .${ROW_PLAY_CLASS}`;
const OPEN_KEY = "Enter";
const TOGGLE_KEY = " ";

/** The ids of the pickable rows, top to bottom. */
export function visibleIds(container) {
  return [...new Set([...container.querySelectorAll(PICKABLE_ROW)].map((row) => row.dataset.id))];
}

function paintPick(el) {
  const picked = selection.has(el.dataset.id);
  el.classList.toggle(PICKED_CLASS, picked);
  el.querySelector(`.${PICK_BOX_CLASS}`)?.setAttribute("aria-checked", String(picked));
}

export function paintPicks(container) {
  for (const row of container.querySelectorAll(PICKABLE_ROW)) paintPick(row);
}

// A click on the box reaches wirePicking's row click, so it picks as a click on the row does.
function pickBoxEl(el) {
  const label = t("libSort.selectSong", { title: el.querySelector(".cat-title")?.textContent ?? "" });
  const box = document.createElement("button");
  box.type = "button";
  box.className = PICK_BOX_CLASS;
  box.tabIndex = OUT_OF_TAB_ORDER;
  box.setAttribute("role", CHECKBOX_ROLE);
  box.setAttribute("aria-label", label);
  box.title = label;
  box.innerHTML = icon("check");
  return box;
}

/** Give a drawn song its pick box while picking, and make it a My order drop target when sorted so. */
export function decorateSongEl(el, kind) {
  if (!el) return el;
  if (selection.picking && selectScopeOf(kind)) {
    const host = el.classList.contains(SONG_CARD_CLASS) ? el.querySelector(".cat-thumb") : el;
    host?.prepend(pickBoxEl(el));
    paintPick(el);
  }
  if (showsMyOrder(kind, libraryView())) wireMyOrderDrop(el);
  return el;
}

/** Let picking claim clicks on `container`'s rows before the list shows or opens a song. */
export function wirePicking(container, { viewKind, onPicksChange }) {
  function pickRowOf(e) {
    if (!selectScopeOf(viewKind())) return null;
    const row = e.target.closest?.(PICKABLE_ROW);
    return row && container.contains(row) && !e.target.closest(NOT_A_PICK) ? row : null;
  }

  function onPickClick(e) {
    const row = pickRowOf(e);
    if (!row) return;
    const modifiers = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    if (!selection.click(row.dataset.id, modifiers, visibleIds(container))) return;
    e.stopPropagation();
    e.preventDefault();
    onPicksChange();
  }

  function onPickingDoubleClick(e) {
    if (selection.picking && pickRowOf(e)) e.stopPropagation();
  }

  function onPickingKeydown(e) {
    const row = selection.picking && e.target === pickRowOf(e) ? e.target : null;
    if (!row || (e.key !== OPEN_KEY && e.key !== TOGGLE_KEY)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.key === TOGGLE_KEY) {
      selection.toggle(row.dataset.id);
      onPicksChange();
    }
  }

  container.addEventListener("click", onPickClick, true);
  container.addEventListener("dblclick", onPickingDoubleClick, true);
  container.addEventListener("keydown", onPickingKeydown, true);
}
