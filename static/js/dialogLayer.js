import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";

const openLayers = [];
let listening = false;

function topLayer() {
  return openLayers[openLayers.length - 1] ?? null;
}

export function hasOpenDialog() {
  return openLayers.length > 0;
}

function closeLayer(layer) {
  const at = openLayers.indexOf(layer);
  if (at < 0) return;
  openLayers.splice(at, 1);
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

/** `onClose` hides or removes `scrim`; `canClose` holds the dialog open while it is busy. */
export function openDialogLayer(scrim, { onClose, canClose = () => true, opener = document.activeElement } = {}) {
  const layer = { scrim, onClose, canClose, opener, onScrimPress: null };
  layer.onScrimPress = function onScrimPress(e) {
    if (e.target !== scrim || !layer.canClose()) return;
    e.preventDefault();
    closeLayer(layer);
  };
  scrim.addEventListener("mousedown", layer.onScrimPress);
  openLayers.push(layer);
  if (!listening) document.addEventListener("keydown", onLayerKeydown);
  listening = true;
  return { close: () => closeLayer(layer) };
}
