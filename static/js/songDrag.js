// Dragging a library song: onto a folder, a setlist or the Trash, in the sidebar
// and in Browse library, or onto the studio to open it.

export const TRACK_DRAG_TYPE = "application/x-stemdeck-track";
const PLAIN_TEXT = "text/plain";
const DRAGGING_CLASS = "dragging";
export const DROP_TARGET_CLASS = "drop-target";

let draggedId = null;

export function isTrackDragEvent(event) {
  return draggedId != null || Boolean(event?.dataTransfer?.types?.includes(TRACK_DRAG_TYPE));
}

export function getDraggedTrackId(event) {
  return event?.dataTransfer?.getData(TRACK_DRAG_TYPE)
    || event?.dataTransfer?.getData(PLAIN_TEXT)
    || draggedId;
}

function startDrag(trackId, itemEl, event) {
  draggedId = trackId;
  if (event?.dataTransfer) {
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(TRACK_DRAG_TYPE, trackId);
    event.dataTransfer.setData(PLAIN_TEXT, trackId);
  }
  itemEl.classList.add(DRAGGING_CLASS);
}

function endDrag(itemEl) {
  draggedId = null;
  itemEl.classList.remove(DRAGGING_CLASS);
  for (const el of document.querySelectorAll(`.${DROP_TARGET_CLASS}`)) el.classList.remove(DROP_TARGET_CLASS);
}

export function wireTrackDrag(el, trackId) {
  el.draggable = true;
  el.addEventListener("dragstart", function onSongDragStart(e) {
    startDrag(trackId, el, e);
  });
  el.addEventListener("dragend", function onSongDragEnd() {
    endDrag(el);
  });
}

/** `accepts(event)`, when given, can refuse a drag; `effect` is the cursor's drop effect. */
export function wireDropTarget(el, onDrop, { accepts = () => true, effect = "move" } = {}) {
  el.addEventListener("dragover", function onSongDragOver(e) {
    if (!isTrackDragEvent(e) || !accepts(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = effect;
    el.classList.add(DROP_TARGET_CLASS);
  });
  el.addEventListener("dragleave", function onSongDragLeave(e) {
    if (!el.contains(e.relatedTarget)) el.classList.remove(DROP_TARGET_CLASS);
  });
  el.addEventListener("drop", function onSongDrop(e) {
    if (!isTrackDragEvent(e) || !accepts(e)) return;
    const trackId = getDraggedTrackId(e);
    el.classList.remove(DROP_TARGET_CLASS);
    if (!trackId) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(trackId);
  });
}
