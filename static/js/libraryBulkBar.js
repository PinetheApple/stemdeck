// Each action runs the row's own action for every pick, in pick order, so a bulk change
// behaves as that many single ones would.

import { t, plural, getLanguage } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { folderChoices, getLibraryTrack, moveTrackToFolder, restoreTracksFromTrash, toggleFavorite } from "./catalog.js";
import { addSongToSetlist, createSetlistFrom, getSetlists } from "./setlists.js";
import { queueUpNext } from "./upNext.js";
import { trashAllWithUndo } from "./trashUndo.js";
import { menuItem, openMenu, placeBelow } from "./floatMenu.js";
import {
  BULK_ACTION, BULK_ACTIONS, BULK_ACTION_LABEL_KEYS, SELECT_DONE_LABEL_KEY, bulkTargets,
} from "./librarySelection.js";
import { selectScopeOf } from "./libraryArrange.js";
import { selection } from "./libraryView.js";

export const BULK_BAR_ID = "libraryBulkBar";
const COUNT_CLASS = "library-bulk-count";
const ACTION_ICONS = Object.freeze({
  [BULK_ACTION.UP_NEXT]: "listPlus",
  [BULK_ACTION.ADD_TO_SETLIST]: "listMusic",
  [BULK_ACTION.MOVE_TO_FOLDER]: "folder",
  [BULK_ACTION.FAVORITE]: "heart",
  [BULK_ACTION.TRASH]: "trash",
  [BULK_ACTION.RESTORE]: "restore",
});
const DANGER_ACTIONS = new Set([BULK_ACTION.TRASH]);
const SELECT_ALL = "selectAll";
const DONE = "done";

let bar = null;
let hooks = { finish: () => {}, selectAll: () => {} };

const isFavoriteId = (id) => Boolean(getLibraryTrack(id)?.favorite);

async function addAllToSetlist(setlistId, ids) {
  for (const id of ids) await addSongToSetlist(setlistId, id);
}

function moveAllToFolder(folderId, ids) {
  for (const id of ids) moveTrackToFolder(id, folderId);
}

function queueAll(ids) {
  ids.forEach(queueUpNext);
}

function favoriteAll(ids) {
  ids.forEach(toggleFavorite);
}

const RUN_NOW = Object.freeze({
  [BULK_ACTION.UP_NEXT]: queueAll,
  [BULK_ACTION.FAVORITE]: favoriteAll,
  [BULK_ACTION.TRASH]: trashAllWithUndo,
  [BULK_ACTION.RESTORE]: restoreTracksFromTrash,
});

function runOnPicks(run) {
  run(selection.ids());
  hooks.finish();
}

function setlistItem(setlist) {
  function onBulkAddToSetlist() {
    runOnPicks((ids) => addAllToSetlist(setlist.id, ids));
  }
  return menuItem(setlist.name, "listMusic", onBulkAddToSetlist);
}

function onBulkNewSetlist() {
  runOnPicks(createSetlistFrom);
}

function setlistItems() {
  return [...getSetlists().map(setlistItem), menuItem(t("trackMenu.newSetlist"), "plus", onBulkNewSetlist)];
}

function folderItem(folder) {
  function onBulkMoveToFolder() {
    runOnPicks((ids) => moveAllToFolder(folder.id, ids));
  }
  return menuItem(folder.name, "folder", onBulkMoveToFolder, { depth: folder.depth });
}

function folderItems() {
  return folderChoices(null).map(folderItem);
}

const MENUS = Object.freeze({
  [BULK_ACTION.ADD_TO_SETLIST]: setlistItems,
  [BULK_ACTION.MOVE_TO_FOLDER]: folderItems,
});

function runAction(action, anchor) {
  if (MENUS[action]) {
    openMenu(anchor, MENUS[action](), { label: t(BULK_ACTION_LABEL_KEYS[action]), place: placeBelow });
    return;
  }
  runOnPicks((ids) => RUN_NOW[action](bulkTargets(action, ids, isFavoriteId)));
}

function onBulkBarClick(e) {
  const button = e.target.closest("button[data-bulk]");
  if (!button) return;
  const { bulk } = button.dataset;
  if (bulk === SELECT_ALL) hooks.selectAll();
  else if (bulk === DONE) hooks.finish();
  else runAction(bulk, button);
}

function barButton(bulk, text, { iconName = "", className = "" } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `browse-btn ${className}`.trim();
  button.dataset.bulk = bulk;
  button.innerHTML = `${iconName ? icon(iconName) : ""}<span></span>`;
  button.lastChild.textContent = text;
  if (MENUS[bulk]) button.setAttribute("aria-haspopup", "menu");
  return button;
}

function actionButton(action) {
  const className = DANGER_ACTIONS.has(action) ? "is-danger" : "";
  return barButton(action, t(BULK_ACTION_LABEL_KEYS[action]), { iconName: ACTION_ICONS[action], className });
}

const drawnKey = (scope) => `${scope}:${getLanguage()}`;

function drawBar(scope) {
  const count = document.createElement("strong");
  count.className = COUNT_CLASS;
  const spacer = document.createElement("span");
  spacer.className = "library-bulk-spacer";
  bar.replaceChildren(
    count,
    barButton(SELECT_ALL, t("libSort.selectAll"), { className: "browse-btn-quiet" }),
    spacer,
    ...BULK_ACTIONS[scope].map(actionButton),
    barButton(DONE, t(SELECT_DONE_LABEL_KEY), { className: "browse-btn-accent" }),
  );
  bar.setAttribute("aria-label", t("libSort.select"));
  bar.dataset.drawn = drawnKey(scope);
}

// The view's redraw replaces the list's children, so the bar goes back in at its end.
function placeAfterSongs(container) {
  if (container && bar.parentElement !== container) container.append(bar);
}

/** Show the bar at the foot of `container` while picking in a view that picks, its count up to date. */
export function paintBulkBar(kind, container) {
  if (!bar) return;
  const scope = selection.picking ? selectScopeOf(kind) : null;
  bar.hidden = !scope;
  if (!scope) return;
  placeAfterSongs(container);
  if (bar.dataset.drawn !== drawnKey(scope)) drawBar(scope);
  bar.querySelector(`.${COUNT_CLASS}`).textContent = plural("libSort.selected", selection.count());
  for (const button of bar.querySelectorAll("button[data-bulk]")) {
    if (button.dataset.bulk !== SELECT_ALL && button.dataset.bulk !== DONE) button.disabled = !selection.count();
  }
}

export function initBulkBar({ finish, selectAll }) {
  hooks = { finish, selectAll };
  bar = document.getElementById(BULK_BAR_ID);
  bar?.addEventListener("click", onBulkBarClick);
}
