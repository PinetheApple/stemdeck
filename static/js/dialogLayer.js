// dialogLayer.js — the one way a dialog opens: the page dims behind it, Esc or a
// press on the dimmed page closes the dialog on top, and focus goes back to
// whatever opened it. Dialogs stack, so one opened from Settings closes back to Settings.

import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";

const open = [];
let listening = false;

function topLayer() {
  return open[open.length - 1] ?? null;
}

/** True while any dialog is open, so a popover under it ignores clicks made in the dialog. */
export function hasOpenDialog() {
  return open.length > 0;
}

function closeLayer(layer) {
  const at = open.indexOf(layer);
  if (at < 0) return;
  open.splice(at, 1);
  layer.scrim.removeEventListener("mousedown", layer.onScrimPress);
  layer.onClose?.();
  if (layer.opener?.isConnected) layer.opener.focus();
}

function onLayerKeydown(e) {
  const layer = topLayer();
  if (e.key !== ESCAPE_KEY || !layer || e.defaultPrevented) return;
  if (!escapeIsFor(LAYER.DIALOG)) return;
  if (!layer.canClose()) return;
  e.preventDefault();
  closeLayer(layer);
}

/**
 * Register a dialog that is now showing. `scrim` is its dimmed backdrop; `onClose`
 * hides or removes it. Returns { close } for its own close buttons.
 */
export function openDialogLayer(scrim, { onClose, canClose = () => true, opener = document.activeElement } = {}) {
  const layer = { scrim, onClose, canClose, opener, onScrimPress: null };
  layer.onScrimPress = function onScrimPress(e) {
    if (e.target !== scrim || !layer.canClose()) return;
    e.preventDefault();
    closeLayer(layer);
  };
  scrim.addEventListener("mousedown", layer.onScrimPress);
  open.push(layer);
  if (!listening) document.addEventListener("keydown", onLayerKeydown);
  listening = true;
  return { close: () => closeLayer(layer) };
}
