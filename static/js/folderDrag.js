// Dragging a folder row in Browse library: the top quarter of another folder's
// row places it before, the bottom quarter after, the middle nests it inside.
// Unsorted takes no subfolders, so it splits into before and after only.

import { isFolderDescendant, reorderFolder, reparentFolder } from "./catalog.js";

const FOLDER_DRAG_TYPE = "application/x-stemdeck-folder";
const UNSORTED_ID = "f-unsorted";
const ZONE = Object.freeze({ BEFORE: "before", INTO: "into", AFTER: "after" });
const ZONE_CLASSES = Object.values(ZONE).map((zone) => `drop-${zone}`);
const EDGE_SHARE = 0.25;
const HALF = 0.5;
const DRAGGING_CLASS = "folder-dragging";

let draggedFolderId = null;

function dropZone(e, row, noNesting) {
  const rect = row.getBoundingClientRect();
  const at = (e.clientY - rect.top) / rect.height;
  if (noNesting) return at < HALF ? ZONE.BEFORE : ZONE.AFTER;
  if (at < EDGE_SHARE) return ZONE.BEFORE;
  if (at >= 1 - EDGE_SHARE) return ZONE.AFTER;
  return ZONE.INTO;
}

function clearZones(row) {
  row.classList.remove(...ZONE_CLASSES);
}

const canTake = (folderId) => Boolean(draggedFolderId)
  && draggedFolderId !== folderId
  && !isFolderDescendant(draggedFolderId, folderId);

function wireDragSource(row, folderId) {
  row.draggable = true;
  row.addEventListener("dragstart", function onFolderDragStart(e) {
    draggedFolderId = folderId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(FOLDER_DRAG_TYPE, folderId);
    row.classList.add(DRAGGING_CLASS);
  });
  row.addEventListener("dragend", function onFolderDragEnd() {
    draggedFolderId = null;
    row.classList.remove(DRAGGING_CLASS);
    for (const el of document.querySelectorAll(ZONE_CLASSES.map((c) => `.${c}`).join(", "))) clearZones(el);
  });
}

function dropFolder(zone, targetId) {
  if (zone === ZONE.BEFORE) reorderFolder(draggedFolderId, targetId, true);
  else if (zone === ZONE.AFTER) reorderFolder(draggedFolderId, targetId, false);
  else reparentFolder(draggedFolderId, targetId);
}

function wireDropZone(row, folderId) {
  const noNesting = folderId === UNSORTED_ID;
  row.addEventListener("dragover", function onFolderDragOver(e) {
    if (!canTake(folderId)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const zone = dropZone(e, row, noNesting);
    for (const name of Object.values(ZONE)) row.classList.toggle(`drop-${name}`, zone === name);
  });
  row.addEventListener("dragleave", function onFolderDragLeave(e) {
    if (!row.contains(e.relatedTarget)) clearZones(row);
  });
  row.addEventListener("drop", function onFolderDrop(e) {
    if (!canTake(folderId)) return;
    e.preventDefault();
    clearZones(row);
    dropFolder(dropZone(e, row, noNesting), folderId);
  });
}

/** Let the row of `folder` ({ id, system }) be dragged, when it is a user folder, and take folders dropped on it. */
export function wireFolderDrag(row, folder) {
  if (!folder.system) wireDragSource(row, folder.id);
  wireDropZone(row, folder.id);
}
