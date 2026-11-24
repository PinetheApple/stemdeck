// Esc closes the topmost open layer only (error, menu, dialog, Browse library,
// Guide, Stage); each lower layer's handler asks escapeIsFor() first.

export const ESCAPE_KEY = "Escape";
export const LAYER = Object.freeze({
  ERROR: "error",
  FLOAT: "float",
  DIALOG: "dialog",
  BROWSE: "browse",
  GUIDE: "guide",
  STAGE: "stage",
});
export const BROWSE_ID = "browseLibrary";

const ERROR_SHOWN = "#error:not(.hidden)";
export const OPEN_FLOATS = [
  '[role="menu"]',
  '[role="listbox"]:not(select, [aria-multiselectable="true"])',
  ".daw-notif-wrap.open .daw-notif-panel",
  "#stemOverflow.open",
  "#search-panel:not(.hidden)",
  ".ft-pop:not(.hidden)",
  "#composerDrawer:not([hidden])",
].join(", ");
const MODAL = 'dialog[open], [role="dialog"][aria-modal="true"]';
const BROWSE_SHOWN = `#${BROWSE_ID}:not([hidden])`;
const GUIDE_ON = "body.help-mode";
const STAGE_ON = ".app.stage-mode";

const isShown = (el) => el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyle(el).visibility !== "hidden";
const anyShown = (selector) => [...document.querySelectorAll(selector)].some(isShown);

// Browse library is a layer of its own, under the dialogs it opens.
const dialogOf = (el) => {
  const modal = el.closest(MODAL);
  return modal && modal.id !== BROWSE_ID ? modal : null;
};

/** Whether a dialog (not Browse library) is open. */
export function isDialogOpen() {
  return [...document.querySelectorAll(MODAL)].some((el) => el.id !== BROWSE_ID && isShown(el));
}

// A dialog covers the page, so a popover left open behind it is not on top; one inside it is.
function floatOnTop() {
  const dialogOpen = isDialogOpen();
  return [...document.querySelectorAll(OPEN_FLOATS)].some((el) => isShown(el) && (!dialogOpen || dialogOf(el)));
}

const LAYERS = [
  [LAYER.ERROR, () => anyShown(ERROR_SHOWN)],
  [LAYER.FLOAT, floatOnTop],
  [LAYER.DIALOG, isDialogOpen],
  [LAYER.BROWSE, () => anyShown(BROWSE_SHOWN)],
  [LAYER.GUIDE, () => Boolean(document.querySelector(GUIDE_ON))],
  [LAYER.STAGE, () => Boolean(document.querySelector(STAGE_ON))],
];
const isOpen = (layer) => LAYERS.find(([name]) => name === layer)[1]();

let escapeTop = null;

/** The topmost open layer right now, or null. */
export function topLayer() {
  return LAYERS.find(([, open]) => open())?.[0] ?? null;
}

/** Whether an Escape being handled now is meant for this layer. Read it before closing anything. */
export function escapeIsFor(layer) {
  return (escapeTop ?? topLayer()) === layer;
}

function onEscapeHeard(e) {
  escapeTop = e.key === ESCAPE_KEY ? topLayer() : null;
}

// Stage mode listens on the window after this and ignores a handled key; an Esc that closed nothing stays native.
function onEscapeDone(e) {
  const closed = e.key === ESCAPE_KEY && escapeTop && escapeTop !== LAYER.STAGE && !isOpen(escapeTop);
  if (closed) e.preventDefault();
  escapeTop = null;
}

window.addEventListener("keydown", onEscapeHeard, true);
window.addEventListener("keydown", onEscapeDone);
