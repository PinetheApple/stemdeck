// The sidebar's edge, and collapsing the sidebar when a song needs the room.

import { $ } from "./utils.js";
import { isSidebarCollapsed, setSidebarCollapsed } from "./catalog.js";
import { PaneEdge } from "./paneEdge.js";
import { queueShellFit, registerShellEdge, waveSpare } from "./shellEdges.js";

const WIDTH_STORE_KEY = "stemdeck.library.width";
// localStorage like the catalog's collapsed flag: both are read synchronously at startup,
// where storeGet would answer later over the desktop's IPC.
const AUTO_COLLAPSED_KEY = "stemdeck.library.autoCollapsed";
const AUTO_COLLAPSED_STORED = "1";
const COLLAPSED_CLASS = "cat-collapsed";
const WIDTH_VAR = "--library-w";
const MIN_WIDTH_PX = 232;
const MAX_WIDTH_PX = 380;

let sidebar = null;
let app = null;
let collapseWatcher = null;
// Collapsing is only weighed once a song is open, so the library's own saved state lands first.
let watchingRoom = false;
let hadRoom = true;
let autoCollapsed = false;
let userKeptOpen = false;

function hasRoomForLibrary() {
  return sidebar.offsetWidth + waveSpare() >= MIN_WIDTH_PX;
}

function readAutoCollapsed() {
  try {
    return localStorage.getItem(AUTO_COLLAPSED_KEY) === AUTO_COLLAPSED_STORED;
  } catch (e) {
    console.warn("[library] could not read auto-collapse state:", e);
    return false;
  }
}

function writeAutoCollapsed(collapsed) {
  autoCollapsed = collapsed;
  try {
    if (collapsed) localStorage.setItem(AUTO_COLLAPSED_KEY, AUTO_COLLAPSED_STORED);
    else localStorage.removeItem(AUTO_COLLAPSED_KEY);
  } catch (e) {
    console.warn("[library] could not persist auto-collapse state:", e);
  }
}

// Drops this module's own class change, so only the user's toggles reach onCollapseChange.
function setCollapsedForRoom(collapsed) {
  setSidebarCollapsed(collapsed);
  collapseWatcher.takeRecords();
  writeAutoCollapsed(collapsed);
}

function onCollapseChange(records) {
  const was = records[0].oldValue?.split(" ").includes(COLLAPSED_CLASS) ?? false;
  const collapsed = isSidebarCollapsed();
  if (collapsed === was) return;
  // The catalog restoring a collapse this module made, at startup, is not the user overruling it.
  if (collapsed && autoCollapsed && !watchingRoom) return;
  if (autoCollapsed) writeAutoCollapsed(false);
  userKeptOpen = !collapsed && !hasRoomForLibrary();
}

function fitLibraryToRoom() {
  // Stage mode hides the panes beside the lanes, which would inflate the room.
  if (document.querySelector(".app.stage-mode")) return;
  const hasRoom = hasRoomForLibrary();
  if (hasRoom && autoCollapsed) setCollapsedForRoom(false);
  if (!watchingRoom) return;
  if (!hasRoom && hadRoom && !userKeptOpen && !isSidebarCollapsed()) setCollapsedForRoom(true);
  hadRoom = hasRoom;
}

function onFirstTrackOpen() {
  watchingRoom = true;
  queueShellFit();
}

export function initLibraryResize() {
  const handle = $("libraryResizer");
  sidebar = $("catalogPanel");
  app = document.querySelector(".app");
  if (!handle || !sidebar || !app) return;
  const edge = new PaneEdge({
    handle, host: app, cssVar: WIDTH_VAR, min: MIN_WIDTH_PX, max: MAX_WIDTH_PX, storeKey: WIDTH_STORE_KEY,
    measure: () => sidebar.offsetWidth, spare: waveSpare,
  });
  registerShellEdge(edge, fitLibraryToRoom);
  document.addEventListener("trackopen", onFirstTrackOpen, { once: true });
  autoCollapsed = readAutoCollapsed();
  collapseWatcher = new MutationObserver(onCollapseChange);
  collapseWatcher.observe(app, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  new ResizeObserver(queueShellFit).observe(sidebar);
  window.addEventListener("resize", queueShellFit);
  edge.restore().catch(console.error);
}
