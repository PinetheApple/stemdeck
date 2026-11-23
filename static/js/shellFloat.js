// Keeps menus and popovers inside the window. shell.css caps their height so
// they scroll; this moves them back in from any edge they cross.

const WINDOW_EDGE_PX = 8;
const ANCHOR_GAP_PX = 6;
// Popovers placed by their own modules; a translate nudges them without fighting that placement.
const CLAMPED_FLOATS = ".lib-menu, #stemOverflow, #t-export-panel, #search-panel";
const STATIC_FLOATS = ["stemOverflow", "t-export-panel"];

/** Under its anchor, right edges level, inside the window, scrolling when taller than it. */
export function keepInWindow(el, anchor) {
  const room = window.innerHeight - 2 * WINDOW_EDGE_PX;
  el.style.maxHeight = `${room}px`;
  el.style.overflowY = "auto";
  const a = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  const left = Math.min(Math.max(WINDOW_EDGE_PX, a.right - width), window.innerWidth - WINDOW_EDGE_PX - width);
  const top = Math.min(a.bottom + ANCHOR_GAP_PX, window.innerHeight - WINDOW_EDGE_PX - Math.min(height, room));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.max(WINDOW_EDGE_PX, top))}px`;
}

const shift = (start, end, limit) =>
  start < WINDOW_EDGE_PX ? WINDOW_EDGE_PX - start : end > limit - WINDOW_EDGE_PX ? Math.max(WINDOW_EDGE_PX - start, limit - WINDOW_EDGE_PX - end) : 0;

/** Move a shown popover back inside the window, wherever its own code put it. */
export function clampIntoWindow(el) {
  el.style.translate = "";
  if (!el.getClientRects().length) return;
  const r = el.getBoundingClientRect();
  const dx = shift(r.left, r.right, window.innerWidth);
  const dy = shift(r.top, r.bottom, window.innerHeight);
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
}
