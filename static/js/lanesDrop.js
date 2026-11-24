// A library song dropped on the studio's lanes opens there.

import { getLibraryTrack, loadTrackIntoStudio } from "./catalog.js";
import { getDraggedTrackId, isTrackDragEvent } from "./songDrag.js";

const LANES_DROP_CLASS = "library-drop-target";

function lanesEl() {
  return document.getElementById("lanes");
}

function clearLanesDrop() {
  lanesEl()?.classList.remove(LANES_DROP_CLASS);
}

function onLanesDragOver(e) {
  if (!isTrackDragEvent(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  e.currentTarget.classList.add(LANES_DROP_CLASS);
}

function onLanesDragLeave(e) {
  if (!e.currentTarget.contains(e.relatedTarget)) clearLanesDrop();
}

function onLanesDrop(e) {
  const trackId = getDraggedTrackId(e);
  if (!trackId || !getLibraryTrack(trackId)) return;
  e.preventDefault();
  clearLanesDrop();
  loadTrackIntoStudio(trackId);
}

export function initLanesDrop() {
  const lanes = lanesEl();
  if (!lanes) return;
  lanes.addEventListener("dragover", onLanesDragOver);
  lanes.addEventListener("dragleave", onLanesDragLeave);
  lanes.addEventListener("drop", onLanesDrop);
  document.addEventListener("dragend", clearLanesDrop);
}
