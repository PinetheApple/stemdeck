// The bar over Browse library's songs while picking: how many are picked, Select all,
// the actions for them, and Done. Each action does for every pick what the row's own
// button or menu does for one song, in the order they were picked.

import { t, plural, getLanguage } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import {
  folderChoices, getLibraryTrack, moveTrackToFolder, moveTrackToTrash, restoreTracksFromTrash, toggleFavorite,
} from "./catalog.js";
import { addSongToSetlist, createSetlistFrom, getSetlists } from "./setlists.js";
import { queueUpNext } from "./upNext.js";
import { menuItem, openMenu } from "./trackMenu.js";
import { placeUnder } from "./libraryMenus.js";
import {
  BULK_ACTION, BULK_ACTIONS, BULK_ACTION_LABEL_KEYS, SELECT_DONE_LABEL_KEY, bulkTargets,
} from "./librarySelection.js";
import { selectScopeOf } from "./libraryArrange.js";
import { selection } from "./libraryView.js";

export const BULK_BAR_ID = "libraryBulkBar";
const DEPTH_PROPERTY = "--menu-depth";
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

let hooks = { finish: () => {}, selectAll: () => {} };

const isFavorite = (id) => Boolean(getLibraryTrack(id)?.favorite);

async function addAllToSetlist(setlistId, ids) {
  for (const id of ids) await addSongToSetlist(setlistId, id);
}

function moveAllToFolder(folderId, ids) {
  for (const id of ids) moveTrackToFolder(id, folderId);
}

const RUN_NOW = Object.freeze({
  [BULK_ACTION.UP_NEXT]: (ids) => ids.forEach(queueUpNext),
  [BULK_ACTION.FAVORITE]: (ids) => ids.forEach(toggleFavorite),
  [BULK_ACTION.TRASH]: (ids) => ids.forEach(moveTrackToTrash),
  [BULK_ACTION.RESTORE]: (ids) => restoreTracksFromTrash(ids),
});

function runOnPicks(run) {
  run(selection.ids());
  hooks.finish();
}

function setlistItems() {
  const items = getSetlists().map((setlist) => menuItem(setlist.name, "listMusic", function onBulkAddToSetlist() {
    runOnPicks((ids) => addAllToSetlist(setlist.id, ids));
  }));
  return [...items, menuItem(t("trackMenu.newSetlist"), "plus", function onBulkNewSetlist() {
    runOnPicks(createSetlistFrom);
  })];
}

function folderItems() {
  return folderChoices(null).map((folder) => {
    const item = menuItem(folder.name, "folder", function onBulkMoveToFolder() {
      runOnPicks((ids) => moveAllToFolder(folder.id, ids));
    });
    item.classList.add("lib-menu-folder");
    item.style.setProperty(DEPTH_PROPERTY, String(folder.depth));
    return item;
  });
}

const MENUS = Object.freeze({
  [BULK_ACTION.ADD_TO_SETLIST]: setlistItems,
  [BULK_ACTION.MOVE_TO_FOLDER]: folderItems,
});

function runAction(action, anchor) {
  if (MENUS[action]) {
    openMenu(anchor, MENUS[action](), { label: t(BULK_ACTION_LABEL_KEYS[action]), place: placeUnder });
    return;
  }
  runOnPicks((ids) => RUN_NOW[action](bulkTargets(action, ids, isFavorite)));
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

function drawBar(bar, scope) {
  const count = document.createElement("strong");
  count.className = "library-bulk-count";
  const spacer = document.createElement("span");
  spacer.className = "library-bulk-spacer";
  bar.replaceChildren(
    count,
    barButton(SELECT_ALL, t("libSort.selectAll"), { className: "browse-btn-quiet" }),
    spacer,
    ...BULK_ACTIONS[scope].map(actionButton),
    barButton(DONE, t(SELECT_DONE_LABEL_KEY), { className: "browse-btn-accent" }),
  );
  bar.dataset.drawn = drawnKey(scope);
}

/** Show the bar while picking in a view that picks, with the count and actions up to date. */
export function paintBulkBar(kind) {
  const bar = document.getElementById(BULK_BAR_ID);
  if (!bar) return;
  const scope = selection.picking ? selectScopeOf(kind) : null;
  bar.hidden = !scope;
  if (!scope) return;
  if (bar.dataset.drawn !== drawnKey(scope)) drawBar(bar, scope);
  bar.querySelector(".library-bulk-count").textContent = plural("libSort.selected", selection.count());
  for (const button of bar.querySelectorAll("button[data-bulk]")) {
    if (button.dataset.bulk !== SELECT_ALL && button.dataset.bulk !== DONE) button.disabled = !selection.count();
  }
}

export function initBulkBar({ finish, selectAll }) {
  hooks = { finish, selectAll };
  document.getElementById(BULK_BAR_ID)?.addEventListener("click", onBulkBarClick);
}
