// The pane edges, fitted in one order so the song tools give way first, then the
// stem controls, then the sidebar; and the song tools hiding when even that is not enough.

import { $ } from "./utils.js";
import { GROWS_LEFT, PaneEdge } from "./paneEdge.js";
import { MIN_WAVES_PX, PANE_LIMITS } from "./paneEdgeMath.js";

// inspector.js's hidden class, named once here for the shell.
export const TOOLS_HIDDEN_CLASS = "inspector-hidden";
const TOOLS_AUTO_HIDDEN_CLASS = "tools-auto-hidden";
const STAGE_CLASS = "stage-mode";
export const FIT_ORDER = Object.freeze({ TOOLS: 0, STEMS: 1, SIDEBAR: 2 });
const TOOLS_WIDTH_KEY = "stemdeck.inspector.width";
const STEMS_WIDTH_KEY = "stemdeck.stems.width";
const STEMS_WIDTH_VAR = "--daw-col-w";
const TOOLS_WIDTH_VAR = "--inspector-w";

const edges = [];
let fitQueued = false;
let watchingRoom = false;
let toolsKeptOpen = false;

const app = () => document.querySelector(".app");

function stemsColumnWidth() {
  return $("stemsResizer")?.closest(".daw-content")?.querySelector(".daw-stems-panel")?.getBoundingClientRect().width ?? 0;
}

function waveWidth() {
  const wave = document.querySelector(".daw-wave-panel");
  if (wave?.getClientRects().length) return wave.getBoundingClientRect().width;
  return ($("main")?.clientWidth ?? 0) - stemsColumnWidth();
}

/** How far the waveforms are above their minimum width; negative when squeezed. */
export function waveSpare() {
  return waveWidth() - MIN_WAVES_PX;
}

export function isToolsAutoHidden() {
  return Boolean(app()?.classList.contains(TOOLS_AUTO_HIDDEN_CLASS));
}

function setToolsAutoHidden(hidden) {
  app()?.classList.toggle(TOOLS_AUTO_HIDDEN_CLASS, hidden);
}

// Shown song tools at their minimum and still no room: they step aside until there is.
function fitToolsToRoom() {
  const root = app();
  if (!root || !watchingRoom || root.classList.contains(STAGE_CLASS)) return;
  const spare = waveSpare();
  if (isToolsAutoHidden()) {
    if (spare >= PANE_LIMITS.tools.min) setToolsAutoHidden(false);
    return;
  }
  if (spare >= 0) toolsKeptOpen = false;
  else if (!toolsKeptOpen && !root.classList.contains(TOOLS_HIDDEN_CLASS)) setToolsAutoHidden(true);
}

export function fitShellEdges() {
  for (const { edge } of edges) edge.fit();
  for (const { afterFit } of edges) afterFit?.();
  fitToolsToRoom();
}

export function queueShellFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(function fitQueuedEdges() {
    fitQueued = false;
    fitShellEdges();
  });
}

/** Build an edge on .app, fitted in its place in FIT_ORDER, and restore its stored width. */
export function createShellEdge({ order, afterFit, ...options }) {
  const edge = new PaneEdge({ host: app(), spare: waveSpare, ...options });
  edges.push({ order, edge, afterFit });
  edges.sort((a, b) => a.order - b.order);
  edge.restore().catch(console.error);
  return edge;
}

// The top-bar toggle brings auto-hidden song tools back and keeps them, without inspector.js storing a choice.
function onToolsToggleCapture(e) {
  if (!isToolsAutoHidden()) return;
  e.stopImmediatePropagation();
  toolsKeptOpen = true;
  setToolsAutoHidden(false);
}

function onFirstTrackOpen() {
  watchingRoom = true;
  queueShellFit();
}

export function initShellEdges() {
  const stems = $("stemsResizer");
  const tools = $("inspectorResizer");
  const inspector = $("inspector");
  if (!stems || !tools || !inspector) return;
  createShellEdge({
    order: FIT_ORDER.TOOLS, handle: tools, cssVar: TOOLS_WIDTH_VAR, ...PANE_LIMITS.tools,
    storeKey: TOOLS_WIDTH_KEY, measure: () => inspector.offsetWidth, grows: GROWS_LEFT,
  });
  createShellEdge({
    order: FIT_ORDER.STEMS, handle: stems, cssVar: STEMS_WIDTH_VAR, ...PANE_LIMITS.stems,
    storeKey: STEMS_WIDTH_KEY, measure: stemsColumnWidth,
  });
  $("inspectorToggleBtn")?.addEventListener("click", onToolsToggleCapture, true);
  document.addEventListener("trackopen", onFirstTrackOpen, { once: true });
  const observer = new ResizeObserver(queueShellFit);
  for (const el of [document.querySelector(".daw-panes"), inspector, $("main")]) if (el) observer.observe(el);
  window.addEventListener("resize", queueShellFit);
}
