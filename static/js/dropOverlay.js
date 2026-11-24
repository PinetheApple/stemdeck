const OVERLAY_ID = "dropOverlay";
const URL_ZONE = ".url-wrap";
// main.js marks the box with it for the desktop shell's native drags, which carry no "Files".
const DRAG_HOVER_CLASS = "drag-over";
const FILES_TYPE = "Files";

let depth = 0;

const carriesFiles = (e) => !!e.dataTransfer?.types?.includes(FILES_TYPE);

function paintOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  const nativeDrag = document.querySelector(URL_ZONE)?.classList.contains(DRAG_HOVER_CLASS);
  overlay.hidden = depth === 0 && !nativeDrag;
}

function onFilesEnter(e) {
  if (!carriesFiles(e)) return;
  depth += 1;
  paintOverlay();
}

function onFilesLeave(e) {
  if (!carriesFiles(e)) return;
  depth = Math.max(0, depth - 1);
  paintOverlay();
}

function onDragFinished() {
  depth = 0;
  paintOverlay();
}

export function wireDropOverlay() {
  window.addEventListener("dragenter", onFilesEnter, true);
  window.addEventListener("dragleave", onFilesLeave, true);
  window.addEventListener("drop", onDragFinished, true);
  window.addEventListener("dragend", onDragFinished, true);
  const zone = document.querySelector(URL_ZONE);
  if (zone) new MutationObserver(paintOverlay).observe(zone, { attributes: true, attributeFilter: ["class"] });
}
