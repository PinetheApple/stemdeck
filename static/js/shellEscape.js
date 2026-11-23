// One Esc order for the shell: error box, menu or popover, dialog, Guide, Stage
// mode (Browse library slots in above Guide with #234). Each layer's own handler
// still closes it; this module keeps the layers below from closing too.

import { isModalOpen } from "./stageMode.js";

export const LAYER = Object.freeze({ ERROR: "error", FLOAT: "float", DIALOG: "dialog", GUIDE: "guide", STAGE: "stage" });

const ESCAPE_KEY = "Escape";
const ERROR_SHOWN = "#error:not(.hidden)";
const OPEN_FLOATS = '[role="menu"], [role="listbox"]:not(select), .daw-notif-wrap.open .daw-notif-panel';
const MODAL = 'dialog[open], [role="dialog"][aria-modal="true"]';
const GUIDE_ON = "body.help-mode";
const STAGE_ON = ".app.stage-mode";

const isShown = (el) => el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyle(el).visibility !== "hidden";
const anyShown = (selector) => [...document.querySelectorAll(selector)].some(isShown);

// A dialog covers the page, so a popover left open behind it is not on top; one inside it is.
function floatOnTop() {
  const modalOpen = isModalOpen();
  return [...document.querySelectorAll(OPEN_FLOATS)].some((el) => isShown(el) && (!modalOpen || el.closest(MODAL)));
}

const LAYERS = [
  [LAYER.ERROR, () => anyShown(ERROR_SHOWN)],
  [LAYER.FLOAT, floatOnTop],
  [LAYER.DIALOG, isModalOpen],
  [LAYER.GUIDE, () => Boolean(document.querySelector(GUIDE_ON))],
  [LAYER.STAGE, () => Boolean(document.querySelector(STAGE_ON))],
];

let escapeTop = null;

/** The topmost open layer right now, or null. */
export function topLayer() {
  return LAYERS.find(([, isOpen]) => isOpen())?.[0] ?? null;
}

/** Whether an Escape being handled now is meant for this layer. Read it before closing anything. */
export function escapeIsFor(layer) {
  return (escapeTop ?? topLayer()) === layer;
}

function onEscapeHeard(e) {
  escapeTop = e.key === ESCAPE_KEY ? topLayer() : null;
}

// Stage mode listens on the window after this and ignores a handled key.
function onEscapeDone(e) {
  if (e.key === ESCAPE_KEY && escapeTop && escapeTop !== LAYER.STAGE) e.preventDefault();
  escapeTop = null;
}

window.addEventListener("keydown", onEscapeHeard, true);
window.addEventListener("keydown", onEscapeDone);
