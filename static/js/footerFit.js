// Keeps the footer control strip inside the width it actually has.
//
// .footer-clusters is `overflow-x: auto` with `flex: none` children, so it
// never reflows on its own: past a certain width it scrolls instead, and
// controls sit off the right-hand edge with nothing to say so (#586).
//
// Measured rather than written as a media query because the row's width is not
// a function of the viewport: it moves with the language, the fonts and Stage
// mode. The strip itself spans the window, so the library pane does not move it.
//
// Every pass re-measures from the uncollapsed state, so the strip opens back up
// as room returns; reopening takes REOPEN_SLACK to spare, though (#633).

// Least destructive first, and each step costs more than the last.
//
// "rows" moves Speed and Global key onto a second row at full size: the footer
// grows taller, but every control keeps its label and size.
//
// "tight" closes up the spacing between clusters and drops the Loop label.
//
// "compact" drops the remaining labels and shrinks the controls.
const LEVELS = ["rows", "tight", "compact"];

// Room a less collapsed level must have to spare before the strip goes back to
// it. Collapsing still happens the moment the row is short by any amount.
//
// With one threshold, a strip sitting on it flips on any sub-pixel wobble or a
// scrollbar coming and going, and every flip re-triggers the observer (#633).
// 24px is wider than a classic Windows scrollbar at any scale (17px), the
// largest width change anything in the footer can make on its own.
const REOPEN_SLACK = 24;

let strip = null;
let level = 0; // count of LEVELS applied, in order; 0 is fully inline
let queued = false;
let observedWidth = -1; // strip content width the observer last reported

/**
 * How far the widest row runs past the strip's right edge: positive when it
 * overflows, negative by the room it has to spare.
 *
 * Rect edges rather than scrollWidth - clientWidth: those never go below zero
 * and are rounded, so a row at a 2.5 device pixel ratio could read either way.
 */
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

function clearLevels() {
  while (level > 0) strip.classList.remove(`collapse-${LEVELS[--level]}`);
}

function fitsAt(was) {
  const slack = level < was ? REOPEN_SLACK : 0;
  return overrun() + slack <= 0;
}

function apply() {
  queued = false;
  if (!strip || !strip.isConnected) return;

  const was = level;
  clearLevels();

  // A hidden strip has no width to fit anything into.
  if (!strip.clientWidth) return;

  while (level < LEVELS.length && !fitsAt(was)) {
    strip.classList.add(`collapse-${LEVELS[level++]}`);
  }

  // Footer popovers anchor to controls this may have just moved.
  if (level !== was) {
    window.dispatchEvent(new CustomEvent("footerfit", { detail: { level: LEVELS[level - 1] ?? null } }));
  }
}

/**
 * Re-fit on the next frame.
 *
 * Coalesced because the things that call it arrive in bursts: a drag on the
 * window edge fires the observer per frame, and a language switch rewrites
 * every label in one go.
 */
export function refitFooter() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(apply);
}

export function initFooterFit() {
  strip = document.querySelector(".footer-clusters");
  if (!strip) return;

  // Width changes only. The strip's height is an output of the fit ("rows"
  // makes it taller), so re-fitting on it would loop (#633). Content changes
  // that matter call refitFooter() themselves.
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
