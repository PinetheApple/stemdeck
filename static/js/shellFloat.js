// Keeps menus and popovers inside the window: marked with FLOAT_CLASS, which
// shell.css caps in height so they scroll, and moved back in from any edge they cross.

const ANCHOR_GAP_PX = 6;
export const FLOAT_CLASS = "shell-float";
const EDGE_TOKEN = "--float-edge";
// Popovers placed by their own modules; a translate nudges them without fighting that placement.
const CLAMPED_FLOATS = ".lib-menu, #t-export-panel, #search-panel";
const STATIC_FLOATS = ["t-export-panel"];

const windowEdge = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(EDGE_TOKEN));

/** Under its anchor, right edges level, inside the window, scrolling when taller than it. */
export function keepInWindow(el, anchor) {
  const edge = windowEdge();
  const room = window.innerHeight - 2 * edge;
  el.classList.add(FLOAT_CLASS);
  const a = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  const left = Math.min(Math.max(edge, a.right - width), window.innerWidth - edge - width);
  const top = Math.min(a.bottom + ANCHOR_GAP_PX, window.innerHeight - edge - Math.min(height, room));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(edge, top))}px`;
}

function shift(start, end, limit, edge) {
  if (start < edge) return edge - start;
  if (end > limit - edge) return Math.max(edge - start, limit - edge - end);
  return 0;
}

/** Move a shown popover back inside the window, wherever its own code put it. */
export function clampIntoWindow(el) {
  el.classList.add(FLOAT_CLASS);
  el.style.translate = "";
  if (!el.getClientRects().length) return;
  const edge = windowEdge();
  const r = el.getBoundingClientRect();
  const dx = shift(r.left, r.right, window.innerWidth, edge);
  const dy = shift(r.top, r.bottom, window.innerHeight, edge);
  if (dx || dy) el.style.translate = `${Math.round(dx)}px ${Math.round(dy)}px`;
}

let clampQueued = false;

function clampOpenFloats() {
  clampQueued = false;
  for (const el of document.querySelectorAll(CLAMPED_FLOATS)) clampIntoWindow(el);
}

function queueClamp() {
  if (clampQueued) return;
  clampQueued = true;
  requestAnimationFrame(clampOpenFloats);
}

/** Clamp popovers as they open: menus are appended to the body, the others toggle a class. */
export function watchFloats() {
  const opened = new MutationObserver(queueClamp);
  opened.observe(document.body, { childList: true });
  for (const id of STATIC_FLOATS) {
    const el = document.getElementById(id);
    if (el) opened.observe(el, { attributes: true, attributeFilter: ["class"] });
  }
  window.addEventListener("resize", queueClamp);
  // A scroll moves the anchors the popovers were placed from.
  window.addEventListener("scroll", queueClamp, { capture: true, passive: true });
}
