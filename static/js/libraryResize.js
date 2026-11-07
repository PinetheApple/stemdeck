import { $, storeGet, storeSet, storeSetDebounced } from "./utils.js";

const WIDTH_STORE_KEY = "stemdeck.library.width";
const WIDTH_VAR = "--library-w";
const SIZING_CLASS = "is-sizing";
const DRAGGING_CLASS = "is-dragging";

// The floor of --library-w, so a pane on its default width can always go back to it.
const MIN_WIDTH_PX = 232;
const MAX_WIDTH_PX = 560;
// The stem tracks' label column plus a readable stretch of waveform.
const MIN_TRACKS_WIDTH_PX = 480;
const KEYBOARD_STEP_PX = 16;

let handle = null;
let panes = null;
let sidebar = null;
let rail = null;
let inspector = null;

// What the user chose; null means the token's default. Kept apart from the width on
// screen so a window too small for it shrinks the pane without losing the choice.
let preferredWidth = null;
let fitQueued = false;
let dragStartX = 0;
let dragStartWidth = 0;
let dragStartPreferred = null;
let dragMoved = false;

function maxWidth() {
  const room = panes.clientWidth - rail.offsetWidth - inspector.offsetWidth - MIN_TRACKS_WIDTH_PX;
  return Math.max(MIN_WIDTH_PX, Math.min(MAX_WIDTH_PX, room));
}

function clampWidth(px) {
  return Math.round(Math.max(MIN_WIDTH_PX, Math.min(maxWidth(), px)));
}

function measuredWidth() {
  return sidebar.offsetWidth - rail.offsetWidth;
}

function renderWidth() {
  const next = preferredWidth === null ? "" : `${clampWidth(preferredWidth)}px`;
  if (sidebar.style.getPropertyValue(WIDTH_VAR) === next) return;
  sidebar.classList.add(SIZING_CLASS);
  sidebar.style.setProperty(WIDTH_VAR, next);
  // Lays out now, while the width transition is off, so the pane tracks the pointer.
  void sidebar.offsetWidth;
  sidebar.classList.remove(SIZING_CLASS);
}

function syncAria() {
  handle.setAttribute("aria-valuemin", String(MIN_WIDTH_PX));
  handle.setAttribute("aria-valuemax", String(maxWidth()));
  const handleShown = handle.getClientRects().length > 0;
  if (handleShown) handle.setAttribute("aria-valuenow", String(measuredWidth()));
}

function fitWidth() {
  // Stage mode hides the rail and inspector, which would inflate maxWidth().
  if (!rail.offsetWidth) return;
  renderWidth();
  syncAria();
}

function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitWidth();
  });
}

function chooseWidth(px) {
  preferredWidth = clampWidth(px);
  fitWidth();
}

function saveWidthNow() {
  storeSet(WIDTH_STORE_KEY, preferredWidth);
  // Replaces a pending arrow-key write, which would otherwise land after this one.
  storeSetDebounced(WIDTH_STORE_KEY, preferredWidth);
}

function onHandlePointerMove(e) {
  const next = clampWidth(dragStartWidth + e.clientX - dragStartX);
  dragMoved = next !== dragStartWidth;
  preferredWidth = dragMoved ? next : dragStartPreferred;
  fitWidth();
}

// Follows pointerup and pointercancel alike, so a cancelled drag still cleans up.
function onHandleLostCapture() {
  handle.removeEventListener("pointermove", onHandlePointerMove);
  handle.removeEventListener("lostpointercapture", onHandleLostCapture);
  handle.classList.remove(DRAGGING_CLASS);
  if (dragMoved) saveWidthNow();
}

function onHandlePointerDown(e) {
  if (e.button !== 0) return;
  dragStartX = e.clientX;
  dragStartWidth = measuredWidth();
  dragStartPreferred = preferredWidth;
  dragMoved = false;
  handle.setPointerCapture(e.pointerId);
  handle.classList.add(DRAGGING_CLASS);
  handle.addEventListener("pointermove", onHandlePointerMove);
  handle.addEventListener("lostpointercapture", onHandleLostCapture);
}

function resetWidth() {
  preferredWidth = null;
  fitWidth();
  saveWidthNow();
}

function onHandleKeydown(e) {
  if (e.key === "Enter") {
    e.preventDefault();
    resetWidth();
    return;
  }
  const direction = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!direction) return;
  e.preventDefault();
  const current = measuredWidth();
  if (clampWidth(current + direction * KEYBOARD_STEP_PX) === current) return;
  chooseWidth(current + direction * KEYBOARD_STEP_PX);
  storeSetDebounced(WIDTH_STORE_KEY, preferredWidth);
}

async function restoreWidth() {
  const saved = await storeGet(WIDTH_STORE_KEY, null);
  if (!Number.isFinite(saved)) return;
  preferredWidth = saved;
  fitWidth();
}

export function initLibraryResize() {
  handle = $("libraryResizer");
  panes = document.querySelector(".daw-panes");
  sidebar = $("catalogPanel");
  rail = sidebar?.querySelector(".sidebar-rail");
  inspector = $("inspector");
  if (!handle || !panes || !sidebar || !rail || !inspector) return;

  handle.addEventListener("pointerdown", onHandlePointerDown);
  handle.addEventListener("dblclick", resetWidth);
  handle.addEventListener("keydown", onHandleKeydown);

  // The sidebar reports reopening and leaving Stage mode.
  const observer = new ResizeObserver(queueFit);
  observer.observe(panes);
  observer.observe(sidebar);
  observer.observe(inspector);

  fitWidth();
  restoreWidth().catch(console.error);
}
