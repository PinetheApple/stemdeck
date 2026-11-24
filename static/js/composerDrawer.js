import { keepInWindow } from "./shellFloat.js";
import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";
import { closeSearch } from "./search.js";
import { wireEmptyStart } from "./addSongStart.js";
import { wireDropOverlay } from "./dropOverlay.js";

const DRAWER_ID = "composerDrawer";
export const ADD_SONG_ID = "addSongBtn";
const URL_FIELD_ID = "url";
const SEARCH_PANEL_ID = "search-panel";
const HIDDEN_CLASS = "hidden";
// Part of the popover though not inside it: its button, and the search results search.js hangs on <body>.
const OWN_TARGETS = `#${DRAWER_ID}, #${ADD_SONG_ID}, #${SEARCH_PANEL_ID}`;
const MODAL_ABOVE = 'dialog[open], [role="dialog"][aria-modal="true"]';

const drawer = () => document.getElementById(DRAWER_ID);
const addSongBtn = () => document.getElementById(ADD_SONG_ID);
const searchShown = () => document.getElementById(SEARCH_PANEL_ID)?.classList.contains(HIDDEN_CLASS) === false;

export function isComposerOpen() {
  return drawer()?.hidden === false;
}

function placeComposer() {
  const el = drawer();
  const anchor = addSongBtn();
  if (el && anchor && isComposerOpen()) keepInWindow(el, anchor);
}

export function setComposerOpen(open) {
  const el = drawer();
  if (!el) return;
  el.hidden = !open;
  addSongBtn()?.setAttribute("aria-expanded", String(open));
  if (!open) {
    closeSearch();
    return;
  }
  placeComposer();
  document.getElementById(URL_FIELD_ID)?.focus();
}

/** Open the popover so its field can take focus; callers that focus #url go through here. */
export function openComposer() {
  if (!isComposerOpen()) setComposerOpen(true);
}

export function closeComposer({ refocus = false } = {}) {
  if (!isComposerOpen()) return;
  setComposerOpen(false);
  if (refocus) addSongBtn()?.focus();
}

function onAddSongClick() {
  setComposerOpen(!isComposerOpen());
}

// Capture phase: the search results above it are still open here, and search.js closes those first.
function onEscapeKey(e) {
  if (e.key !== ESCAPE_KEY || !isComposerOpen() || searchShown()) return;
  if (escapeIsFor(LAYER.FLOAT)) closeComposer({ refocus: true });
}

function onPointerDownOutside(e) {
  if (!isComposerOpen() || e.target.closest?.(OWN_TARGETS) || e.target.closest?.(MODAL_ABOVE)) return;
  closeComposer();
}

export function wireComposerDrawer() {
  addSongBtn()?.addEventListener("click", onAddSongClick);
  document.addEventListener("keydown", onEscapeKey, true);
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  window.addEventListener("resize", placeComposer);
  wireEmptyStart(openComposer);
  wireDropOverlay();
}
