// One short message with Undo after a removal, above the footer, for a few
// seconds; a new one replaces it. It takes no focus and Esc leaves it alone.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { $ } from "./utils.js";

export const UNDO_MS = 6000;
const TOAST_CLASS = "undo-toast";
const OVERLAY_ROOT_ID = "overlayRoot";

let toast = null;
let timer = 0;

export function dismissUndo() {
  clearTimeout(timer);
  toast?.remove();
  toast = null;
}

function toastButton(className, text, label = text) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  if (text) button.textContent = text;
  return button;
}

function toastEl(text, onUndo) {
  const el = document.createElement("div");
  el.className = TOAST_CLASS;
  el.setAttribute("role", "status");
  const message = document.createElement("span");
  message.className = "undo-toast-text";
  message.textContent = text;
  const undo = toastButton("undo-toast-undo", t("lib.undo"));
  undo.addEventListener("click", onUndo);
  const dismiss = toastButton("undo-toast-dismiss", "", t("job.dismiss"));
  dismiss.innerHTML = icon("x");
  dismiss.addEventListener("click", dismissUndo);
  el.append(message, undo, dismiss);
  return el;
}

export function showUndo(text, undo) {
  dismissUndo();
  toast = toastEl(text, function onUndoClick() {
    dismissUndo();
    undo();
  });
  ($(OVERLAY_ROOT_ID) ?? document.body).append(toast);
  timer = setTimeout(dismissUndo, UNDO_MS);
}
