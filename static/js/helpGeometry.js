// Where a control is on screen, as Guide sees it: what of it is in view, and
// whether it can be seen at all. Rects are viewport (client) coordinates.

export function isRendered(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// A control taking more of the window than this is an area, not a place to point.
export const BIG_AREA_SHARE = 0.04;
export const TRACK_AREA = ".waves-column";
const OPACITY_AND_VISIBILITY = { opacityProperty: true, visibilityProperty: true };
// Fractional layout edges round to whole pixels when an outline is placed.
const EDGE_SLACK_PX = 0.5;
const EDGES = ["left", "top", "right", "bottom"];
export const clipsOverflow = (overflow) => overflow !== "visible";
// When what a control draws is clearly smaller than its box, the ring hugs the drawing.
const CONTENT_FIT_SHARE = 0.6;
export const DRAWING_RING_PAD_PX = 6;
export const BOX_RING_PAD_PX = 3;

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

/** A ring that hugs the drawing when it is clearly smaller than the box, else the box. */
function fitBox(box, drawing) {
  if (drawing.width <= 0 || drawing.height <= 0) return { fit: box, pad: BOX_RING_PAD_PX };
  const small = drawing.width < box.width * CONTENT_FIT_SHARE || drawing.height < box.height * CONTENT_FIT_SHARE;
  if (small) return { fit: drawing, pad: DRAWING_RING_PAD_PX };
  return { fit: box, pad: BOX_RING_PAD_PX };
}

/**
 * What the eye sees of a control. A button is often much bigger than the icon
 * in it, and a ring around the whole box reads as a stray bar, so the ring goes
 * around the drawing.
 * Only the part left in view counts, and with the drawing out of view, the box's.
 */
export function hoverRect(el) {
  const box = el.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  const { fit, pad } = fitBox(box, range.getBoundingClientRect());
  const frame = viewFrame(el);
  const fitInView = intersect(fit, frame);
  const fitShows = fitInView.width > 0 && fitInView.height > 0;
  const seen = fitShows ? fitInView : intersect(box, frame);
  const gap = fitShows ? pad : BOX_RING_PAD_PX;
  const padded = { left: seen.left - gap, top: seen.top - gap, right: seen.right + gap, bottom: seen.bottom + gap };
  return intersect(padded, windowFrame());
}
