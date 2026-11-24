import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";
import { ADD_SONG_ID } from "./addSongIds.js";

const FOCUSABLE = "button:not(:disabled), input:not(:disabled)";

let panel = null;
let scrim = null;
let opener = null;
let onClosed = null;

const isShown = (el) => !!el?.isConnected && el.offsetParent !== null;

export const reviewPanel = () => panel;

/** Mount the empty panel with its change and click listeners; `closed` runs once
 *  it closes. Returns the panel, or the one already open. */
export function mountPanel({ onChange, onClick, closed }) {
  if (panel) return panel;
  opener = document.activeElement;
  onClosed = closed;
  scrim = document.createElement("div");
  scrim.className = "batch-scrim";
  scrim.setAttribute("aria-hidden", "true");
  scrim.addEventListener("click", onScrimClick);
  panel = document.createElement("section");
  panel.className = "batch-review";
  panel.id = "batchReview";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "batchReviewTitle");
  panel.addEventListener("change", onChange);
  panel.addEventListener("click", onClick);
  panel.addEventListener("keydown", onPanelKeydown);
  document.body.append(scrim, panel);
  return panel;
}

export function closePanel({ refocus = true } = {}) {
  if (!panel) return;
  panel.remove();
  scrim.remove();
  panel = null;
  scrim = null;
  onClosed?.();
  if (refocus) returnFocus();
}

/** Back to whatever opened the panel, or to Add song, which holds the batch, when that is hidden. */
export function returnFocus() {
  if (isShown(opener)) opener.focus();
  else document.getElementById(ADD_SONG_ID)?.focus();
}

export function focusFirst() {
  panel?.querySelector(`.batch-review-list :is(${FOCUSABLE}), .batch-review-close`)?.focus();
}

/** Which control has focus, by its row and class, so a redraw can give it back. */
export function focusedControl() {
  const el = document.activeElement;
  if (!el || !panel?.contains(el)) return null;
  return { key: el.closest("[data-key]")?.dataset.key ?? null, cls: el.classList[0] };
}

/** Focus back where it was; a control the redraw removed hands it to the first one. */
export function restoreFocus(focus) {
  if (!panel) return;
  if (!focus) {
    if (!panel.contains(document.activeElement)) focusFirst();
    return;
  }
  const scope = focus.key ? panel.querySelector(`[data-key="${CSS.escape(focus.key)}"]`) : panel;
  const target = (focus.cls && scope?.querySelector(`.${focus.cls}`)) ?? scope?.querySelector("input, button");
  if (target && !target.disabled) target.focus();
  else focusFirst();
}

/** Tab wraps inside the panel; Escape closes it. */
function onPanelKeydown(e) {
  if (e.key === ESCAPE_KEY && escapeIsFor(LAYER.DIALOG)) {
    e.preventDefault();
    e.stopPropagation();
    closePanel();
    return;
  }
  if (e.key !== "Tab") return;
  const stops = [...panel.querySelectorAll(FOCUSABLE)].filter(isShown);
  const edge = e.shiftKey ? stops[0] : stops[stops.length - 1];
  if (document.activeElement !== edge) return;
  e.preventDefault();
  (e.shiftKey ? stops[stops.length - 1] : stops[0])?.focus();
}

function onScrimClick() {
  closePanel();
}
