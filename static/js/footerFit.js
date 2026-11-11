// .footer-clusters scrolls sideways rather than reflowing, hiding controls past its edge.
// Measured, not a media query: the row's width moves with language, fonts and Stage mode.

// The one level: clusters wrap at full size, Speed and Global key first, so no label is hidden.
const ROWS_LEVEL = "rows";
const ROWS_CLASS = `collapse-${ROWS_LEVEL}`;

// Spare room the single row needs before leaving "rows"; wider than a 17px
// Windows scrollbar, so a scrollbar or sub-pixel wobble cannot flip it.
const REOPEN_SLACK = 24;

let strip = null;
let rows = false;
let queued = false;
let observedWidth = -1; // strip content width the observer last reported

// Widest row past the strip's edge, negative when there is room. Rect edges, because
// scrollWidth never goes below zero and rounds, so it cannot measure spare room.
function overrun() {
  const box = strip.getBoundingClientRect();
  let left = Infinity;
  let right = -Infinity;
  for (const el of strip.children) {
    const r = el.getBoundingClientRect();
    // Zero height is the "rows" line break, which spans the strip by design.
    if (!r.width || !r.height) continue;
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  return right > left ? right - left - box.width : -box.width;
}

function singleRowFitsFrom(wasRows) {
  const slack = wasRows ? REOPEN_SLACK : 0;
  return overrun() + slack <= 0;
}

function apply() {
  queued = false;
  if (!strip || !strip.isConnected) return;

  const wasRows = rows;
  strip.classList.remove(ROWS_CLASS);
  rows = false;

  // A hidden strip has no width to fit anything into.
  if (!strip.clientWidth) return;

  rows = !singleRowFitsFrom(wasRows);
  strip.classList.toggle(ROWS_CLASS, rows);

  // Footer popovers anchor to controls this may have just moved.
  if (rows !== wasRows) {
    window.dispatchEvent(new CustomEvent("footerfit", { detail: { level: rows ? ROWS_LEVEL : null } }));
  }
}

// Coalesced to one pass per frame: a window drag fires the observer every frame,
// and a language switch rewrites every label at once.
export function refitFooter() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(apply);
}

export function initFooterFit() {
  strip = document.querySelector(".footer-clusters");
  if (!strip) return;

  // Width changes only: "rows" changes the strip's height, so re-fitting on it
  // would loop. Content changes that matter call refitFooter() themselves.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver((entries) => {
      const width = entries[entries.length - 1].contentRect.width;
      if (width === observedWidth) return;
      observedWidth = width;
      refitFooter();
    }).observe(strip);
  } else {
    window.addEventListener("resize", refitFooter);
  }

  refitFooter();
}
