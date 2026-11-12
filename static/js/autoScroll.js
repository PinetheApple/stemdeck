import { storeGet, storeSet } from "./utils.js";
import { waveScroll, totalDuration } from "./state.js";
import { followStep, isBackwardJump, isUserScroll } from "./pageTurn.js";

const STORE_KEY = "stemdeck:auto-scroll";

let enabled = true;
let paused = false;
let holdToEdge = false;
let resumeRequested = false;
let lastSec = 0;
let knownScrollLeft = 0;
let lastIntentAt = -Infinity;
let pointerHeld = false;

function readView(sec) {
  const contentWidth = waveScroll.scrollWidth;
  return {
    scrollLeft: waveScroll.scrollLeft,
    viewportWidth: waveScroll.clientWidth,
    contentWidth,
    playheadX: (sec / totalDuration) * contentWidth,
  };
}

function scrollTimelineTo(left) {
  waveScroll.scrollTo({ left, behavior: "instant" });
  knownScrollLeft = waveScroll.scrollLeft;
}

/** Keep the playhead at `sec` in view. `seek` marks a jump the user asked for. */
export function trackPlayhead(sec, seek = false) {
  if (!waveScroll || !(totalDuration > 0)) return;
  const resumed = seek || resumeRequested || isBackwardJump(lastSec, sec);
  lastSec = sec;
  resumeRequested = false;
  const step = followStep({ enabled, paused, resumed, holdToEdge }, readView(sec));
  paused = step.paused;
  holdToEdge = step.holdToEdge;
  if (step.target !== null) scrollTimelineTo(step.target);
}

export function resumeFollowing() {
  resumeRequested = true;
}

export function resetFollowing() {
  paused = false;
  holdToEdge = false;
  resumeRequested = false;
  lastSec = 0;
  knownScrollLeft = waveScroll?.scrollLeft ?? 0;
}

function noteScrollIntent() {
  lastIntentAt = performance.now();
}

function handleTimelineWheel(event) {
  const pans = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
  if (pans) noteScrollIntent();
}

function handleTimelinePointerDown() {
  pointerHeld = true;
  noteScrollIntent();
}

function handlePointerRelease() {
  if (!pointerHeld) return;
  pointerHeld = false;
  noteScrollIntent();
}

function handleTimelineScroll() {
  const scrollLeft = waveScroll.scrollLeft;
  const sinceIntentMs = performance.now() - lastIntentAt;
  if (isUserScroll({ knownScrollLeft, scrollLeft, sinceIntentMs, pointerHeld })) paused = true;
  knownScrollLeft = scrollLeft;
}

function wireScrollIntent() {
  waveScroll.addEventListener("wheel", handleTimelineWheel, { passive: true });
  waveScroll.addEventListener("pointerdown", handleTimelinePointerDown);
  waveScroll.addEventListener("touchstart", noteScrollIntent, { passive: true });
  waveScroll.addEventListener("keydown", noteScrollIntent);
  window.addEventListener("pointerup", handlePointerRelease);
  window.addEventListener("pointercancel", handlePointerRelease);
  waveScroll.addEventListener("scroll", handleTimelineScroll, { passive: true });
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
  if (waveScroll) wireScrollIntent();
  const button = document.getElementById("autoScrollBtn");
  if (!button) return;
  enabled = (await storeGet(STORE_KEY, true)) !== false;
  showEnabled(button);
  button.addEventListener("click", handleAutoScrollToggle);
}
