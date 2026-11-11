// Auto-scroll: the zoomed timeline follows the playhead, with a toggle by the
// Collapse row. The decisions live in followPlayhead.js.

import { storeGet, storeSet } from "./utils.js";
import { waveScroll, totalDuration } from "./state.js";
import { followStep, isBackwardJump, isManualScroll } from "./followPlayhead.js";

const STORE_KEY = "stemdeck:auto-scroll";

let enabled = true;
let paused = false;
let resumeRequested = false;
let lastSec = 0;
let knownScrollLeft = 0;

function readView(sec) {
  const contentWidth = waveScroll.scrollWidth;
  return {
    scrollLeft: waveScroll.scrollLeft,
    viewportWidth: waveScroll.clientWidth,
    contentWidth,
    playheadX: (sec / totalDuration) * contentWidth,
  };
}

// Instant, because the scroller's CSS asks for smooth scrolling, and a smooth
// turn reports every in-between offset as if the user had scrolled.
function scrollTimelineTo(left) {
  waveScroll.scrollTo({ left, behavior: "instant" });
  knownScrollLeft = waveScroll.scrollLeft;
}

/** Keep the playhead at `sec` in view. `seek` marks a jump the user asked for. */
export function followPlayhead(sec, seek = false) {
  if (!waveScroll || !(totalDuration > 0)) return;
  const resumed = seek || resumeRequested || isBackwardJump(lastSec, sec);
  lastSec = sec;
  resumeRequested = false;
  const step = followStep({ enabled, paused, resumed }, readView(sec));
  paused = step.paused;
  if (step.target !== null) scrollTimelineTo(step.target);
}

/** Play was pressed: follow again even if a manual scroll paused it. */
export function resumeFollowing() {
  resumeRequested = true;
}

/** A new track starts from the top with following live. */
export function resetFollowing() {
  paused = false;
  resumeRequested = false;
  lastSec = 0;
  knownScrollLeft = waveScroll?.scrollLeft ?? 0;
}

function handleTimelineScroll() {
  const now = waveScroll.scrollLeft;
  if (!isManualScroll(knownScrollLeft, now)) return;
  knownScrollLeft = now;
  paused = true;
}

function showEnabled(button) {
  button.setAttribute("aria-pressed", String(enabled));
}

function handleAutoScrollToggle(event) {
  enabled = !enabled;
  paused = false;
  showEnabled(event.currentTarget);
  storeSet(STORE_KEY, enabled);
}

export async function initAutoScroll() {
  waveScroll?.addEventListener("scroll", handleTimelineScroll, { passive: true });
  const button = document.getElementById("autoScrollBtn");
  if (!button) return;
  enabled = (await storeGet(STORE_KEY, true)) !== false;
  showEnabled(button);
  button.addEventListener("click", handleAutoScrollToggle);
}
