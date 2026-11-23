// Keeps a popover inside the window: under its anchor, right edges level, moved
// back in from any edge, and scrolling inside itself when taller than the window.

export const WINDOW_EDGE_PX = 8;
const ANCHOR_GAP_PX = 6;

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
