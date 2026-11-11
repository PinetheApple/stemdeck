// Where a control is on screen, as Guide sees it: what of it is in view, and
// whether it can be seen at all. Rects are viewport (client) coordinates.

export function isRendered(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

const OPACITY_AND_VISIBILITY = { opacityProperty: true, visibilityProperty: true };
// Fractional layout edges round to whole pixels when an outline is placed.
const EDGE_SLACK_PX = 0.5;
const EDGES = ["left", "top", "right", "bottom"];
export const clipsOverflow = (overflow) => overflow !== "visible";
// When what a control draws is clearly smaller than its box, the ring hugs the drawing.
const CONTENT_FIT_SHARE = 0.6;
const DRAWING_RING_PAD_PX = 6;
const BOX_RING_PAD_PX = 3;

function intersect(a, b) {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right), bottom = Math.min(a.bottom, b.bottom);
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

const windowFrame = () => ({ left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight });

/** The window, narrowed by every scrolling or clipping panel around the element. */
function viewFrame(el) {
  let { left, top, right, bottom } = windowFrame();
  for (let panel = el.parentElement; panel && panel !== document.body; panel = panel.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(panel);
    const p = panel.getBoundingClientRect();
    if (clipsOverflow(overflowX)) [left, right] = [Math.max(left, p.left), Math.min(right, p.right)];
    if (clipsOverflow(overflowY)) [top, bottom] = [Math.max(top, p.top), Math.min(bottom, p.bottom)];
  }
  return { left, top, right, bottom };
}

/** The part of a control left in view. */
export const inViewRect = (el) => intersect(el.getBoundingClientRect(), viewFrame(el));

export function isInView(el) {
  const r = inViewRect(el);
  return r.width > 0 && r.height > 0;
}

/** True when opacity 0 (its own or an ancestor's) or visibility hides the control. */
function isSeeThrough(el) {
  if (el.checkVisibility) return !el.checkVisibility(OPACITY_AND_VISIBILITY);
  if (getComputedStyle(el).visibility !== "visible") return true;
  for (let node = el; node; node = node.parentElement) {
    if (getComputedStyle(node).opacity === "0") return true;
  }
  return false;
}

/** Seen in full: not see-through, and nothing of it scrolled away or cut off by a panel. */
export function isWhollyShown(el) {
  if (isSeeThrough(el)) return false;
  const full = el.getBoundingClientRect();
  const seen = inViewRect(el);
  return seen.width > 0 && seen.height > 0
    && EDGES.every((edge) => Math.abs(full[edge] - seen[edge]) <= EDGE_SLACK_PX);
}

/**
 * What the eye sees of a control. A button is often much bigger than the icon
 * in it, and a ring around the whole box reads as a stray bar, so when the
 * drawing is clearly smaller than the box the ring goes around the drawing.
 * Otherwise it takes in both: a rail label can hang below its button's own box.
 * Only the part left in view counts.
 */
export function hoverRect(el) {
  const r = el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const c = range.getBoundingClientRect();
  const drawn = c.width > 0 && c.height > 0;
  const small = drawn && (c.width < r.width * CONTENT_FIT_SHARE || c.height < r.height * CONTENT_FIT_SHARE);
  const union = {
    left: Math.min(r.left, c.left),
    top: Math.min(r.top, c.top),
    right: Math.max(r.right, c.right),
    bottom: Math.max(r.bottom, c.bottom),
  };
  const seen = intersect(small ? c : drawn ? union : r, viewFrame(el));
  const pad = small ? DRAWING_RING_PAD_PX : BOX_RING_PAD_PX;
  const padded = { left: seen.left - pad, top: seen.top - pad, right: seen.right + pad, bottom: seen.bottom + pad };
  return intersect(padded, windowFrame());
}
