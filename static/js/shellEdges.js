// The stem controls column and song tools edges, and the room they share with
// the waveforms. The sidebar's edge is libraryResize.js, which also collapses it.

import { $ } from "./utils.js";
import { GROWS_LEFT, PaneEdge } from "./paneEdge.js";

export const MIN_WAVES_PX = 320;
const STEMS_LIMITS = { min: 328, max: 480 };
const TOOLS_LIMITS = { min: 320, max: 520 };
const STEMS_WIDTH_VAR = "--daw-col-w";
const TOOLS_WIDTH_VAR = "--inspector-w";

const edges = [];
const afterFits = [];
let fitQueued = false;

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

/** Right-hand panes first, so a narrower window takes from the song tools before the sidebar. */
export function fitShellEdges() {
  for (const edge of edges) edge.fit();
  for (const afterFit of afterFits) afterFit();
}

export function queueShellFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(function fitQueuedEdges() {
    fitQueued = false;
    fitShellEdges();
  });
}

function addEdge(options) {
  const edge = new PaneEdge({ host: document.querySelector(".app"), spare: waveSpare, ...options });
  edges.push(edge);
  edge.restore().catch(console.error);
  return edge;
}

/** The library's edge joins the list last, so it is fitted after the other two; afterFit runs on every fit. */
export function registerShellEdge(edge, afterFit) {
  edges.push(edge);
  if (afterFit) afterFits.push(afterFit);
}

export function initShellEdges() {
  const stems = $("stemsResizer");
  const tools = $("inspectorResizer");
  const inspector = $("inspector");
  if (!stems || !tools || !inspector) return;
  addEdge({ handle: tools, cssVar: TOOLS_WIDTH_VAR, ...TOOLS_LIMITS, storeKey: "stemdeck.inspector.width", measure: () => inspector.offsetWidth, grows: GROWS_LEFT });
  addEdge({ handle: stems, cssVar: STEMS_WIDTH_VAR, ...STEMS_LIMITS, storeKey: "stemdeck.stems.width", measure: stemsColumnWidth });
  const observer = new ResizeObserver(() => queueShellFit());
  for (const el of [document.querySelector(".daw-panes"), inspector, $("main")]) if (el) observer.observe(el);
}
