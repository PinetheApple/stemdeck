// One menu for a song wherever it is listed: its ⋯ button and a right-click open it,
// at the button or at the pointer. The open song's head offers it without Rename.

import {
  PROCESSING_STATUSES, folderChoices, getCurrentTrackInfo, getLibraryTrack, isInTrash, isPlayableTrack,
  isTextEditingTarget,
} from "./catalog.js";
import { getSetlists } from "./setlists.js";
import { getNowAndUpNextIds } from "./upNext.js";
import { isExtracting } from "./extractRun.js";
import { currentIds, getQueueSnapshot } from "./queue.js";
import { FAILED_STATUS, needsFilePickedAgain } from "./importSource.js";
import { missingStems, openVersionOf } from "./versionModel.js";
import { closeMenu, menuItem, menuLabel, menuSeparator, openMenu, placeAtPoint, placeBeside } from "./floatMenu.js";
import { ROW_STATE, buildSongMenuModel } from "./songMenuModel.js";
import { SONG_ACTIONS } from "./songMenuActions.js";
import { titleOf } from "./songRowParts.js";
import { t } from "./i18n.js";
import { isReimportableSource, $ } from "./utils.js";

/** Marks an element whose right-click opens the song menu; "head" is the open song's. */
export const SONG_MENU_ATTR = "data-song-menu";
const HEAD = "head";
const HEAD_MORE_ID = "songMoreBtn";
const SONG_MENU_CLASS = "song-menu";
const VERSION_ROW = ".cat-version";
const VERSION_MENU_BUTTON = ".cat-more";
const TRACK_MENU_EVENT = "trackmenu";
const SECONDARY_BUTTON = 2;
const DONE_STATUS = "done";
const STOPPED_STATUS = "stopped";

function rowStateOf(trackId, track) {
  if (isInTrash(trackId)) return ROW_STATE.TRASHED;
  if (PROCESSING_STATUSES.has(track.status) || currentIds(getQueueSnapshot()).has(trackId)) return ROW_STATE.IMPORTING;
  if (track.status === FAILED_STATUS) return ROW_STATE.FAILED;
  if (track.status === STOPPED_STATUS) return ROW_STATE.STOPPED;
  return track.status === DONE_STATUS ? ROW_STATE.DONE : ROW_STATE.UNAVAILABLE;
}

function canExtractMore(track) {
  const open = openVersionOf(track);
  return Boolean(open) && missingStems(open.stems).length > 0;
}

function songMenuInput(trackId, track, rename) {
  return {
    id: trackId,
    state: rowStateOf(trackId, track),
    favorite: Boolean(track.favorite),
    rename,
    queuedIds: getNowAndUpNextIds(),
    extracting: isExtracting(trackId),
    canExtractMore: canExtractMore(track),
    upload: !isReimportableSource(track.sourceUrl),
    pickAgain: needsFilePickedAgain(track),
    setlists: getSetlists(),
    folders: folderChoices(trackId),
  };
}

function entryEl(entry, trackId, anchor) {
  if (entry.kind === "sep") return menuSeparator();
  if (entry.kind === "label") return menuLabel(t(entry.labelKey));
  const text = entry.text ?? t(entry.labelKey);
  const item = menuItem(text, entry.icon, function onSongMenuChoice(chosen) {
    SONG_ACTIONS[entry.action](trackId, { entry, item: chosen, anchor });
  }, { disabled: entry.disabled, keep: Boolean(entry.confirmKey), depth: entry.depth ?? null });
  if (entry.danger) item.classList.add("is-danger");
  if (entry.checked) item.setAttribute("aria-current", "true");
  return item;
}

/** Open the menu of `trackId` from `anchor`, at `point` when a right-click gave one. */
export function openSongMenu(trackId, { anchor, point = null, rename = true }) {
  const track = getLibraryTrack(trackId);
  if (!track || !anchor) {
    closeMenu();
    return;
  }
  const entries = buildSongMenuModel(songMenuInput(trackId, track, rename));
  openMenu(anchor, entries.map((entry) => entryEl(entry, trackId, anchor)), {
    label: t("trackMenu.openTitle", { title: titleOf(track) }),
    place: point ? placeAtPoint(point) : placeBeside,
    className: SONG_MENU_CLASS,
    toggle: !point,
  });
}

/** The open song's menu needs a song that can play, as its Up Next button does. */
function headTarget() {
  const id = getCurrentTrackInfo()?.id;
  return isPlayableTrack(id) ? { id, anchor: $(HEAD_MORE_ID), rename: false } : null;
}

function menuTarget(host) {
  if (host.getAttribute(SONG_MENU_ATTR) === HEAD) return headTarget();
  return host.dataset.id ? { id: host.dataset.id, anchor: host, rename: true } : null;
}

// A right-click with the mouse opens at the pointer; the keyboard's menu key, beside the row.
function pointOf(e) {
  return e.button === SECONDARY_BUTTON ? { x: e.clientX, y: e.clientY } : null;
}

function onSongContextMenu(e) {
  if (isTextEditingTarget(e.target)) return;
  const version = e.target.closest?.(VERSION_ROW);
  if (version) {
    e.preventDefault();
    version.querySelector(VERSION_MENU_BUTTON)?.click();
    return;
  }
  const host = e.target.closest?.(`[${SONG_MENU_ATTR}]`);
  const target = host && menuTarget(host);
  if (!target?.anchor) return;
  e.preventDefault();
  openSongMenu(target.id, { anchor: target.anchor, point: pointOf(e), rename: target.rename });
}

function onTrackMenuRequest(e) {
  const { id, anchor } = e.detail || {};
  openSongMenu(id, { anchor });
}

export function initSongMenu() {
  document.addEventListener("contextmenu", onSongContextMenu);
  document.addEventListener(TRACK_MENU_EVENT, onTrackMenuRequest);
}
