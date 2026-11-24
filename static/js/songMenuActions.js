// What each song menu item does. songMenu.js builds the menu and calls these.

import {
  TRACK_SHOW_EVENT, extractStoppedTrack, getCurrentTrackInfo, moveTrackToFolder, moveTrackToNewFolder,
  restoreTracksFromTrash, retryFailedImport, toggleFavorite,
} from "./catalog.js";
import { addSongToSetlist, createSetlistFrom } from "./setlists.js";
import { queueUpNext } from "./upNext.js";
import { openSong, playSong } from "./openSong.js";
import { cancelExtract } from "./extractRun.js";
import { cancelQueuedJob } from "./queue.js";
import { isStageMode, setStageMode } from "./stageMode.js";
import { closeBrowse, revealSongRows } from "./browseLibrary.js";
import { trashWithUndo } from "./trashUndo.js";
import { openSongRename } from "./songRenameDialog.js";
import { closeMenu } from "./floatMenu.js";
import { confirmOnSecondClick } from "./armConfirm.js";
import { EXTRACT_REQUEST_EVENT } from "./extractMore.js";
import { SONG_ACTION as A } from "./songMenuModel.js";
import { t } from "./i18n.js";
import { $ } from "./utils.js";

const ABOUT_BUTTON_ID = "np-details-btn";
const SHOWN_EVENTS = ["trackopen", TRACK_SHOW_EVENT];

function clickAbout() {
  $(ABOUT_BUTTON_ID)?.click();
}

/** Run `then` once the studio shows `trackId`; given up when another song comes first. */
function whenShown(trackId, then) {
  function onShown(e) {
    for (const name of SHOWN_EVENTS) document.removeEventListener(name, onShown);
    if (e.detail?.id === trackId) then();
  }
  for (const name of SHOWN_EVENTS) document.addEventListener(name, onShown);
}

/** About is the song head's; a song not open is shown first, without playing it. */
function showAbout(trackId) {
  if (getCurrentTrackInfo()?.id === trackId) {
    clickAbout();
    return;
  }
  whenShown(trackId, clickAbout);
  openSong(trackId);
}

/** The song head and Stage offer Extract too, so Browse library and the song's row come on screen first. */
function extractMore(trackId, { anchor }) {
  if (isStageMode()) setStageMode(false);
  revealSongRows();
  document.dispatchEvent(new CustomEvent(EXTRACT_REQUEST_EVENT, { detail: { id: trackId, anchor } }));
}

function cancelImport(trackId, { item, entry }) {
  if (!entry.confirmKey) {
    cancelQueuedJob(trackId);
    return;
  }
  confirmOnSecondClick(item, {
    label: item.querySelector("span"),
    armedText: t(entry.confirmKey),
    onConfirm: function onConfirmCancelImport() {
      closeMenu();
      cancelQueuedJob(trackId);
    },
  });
}

function playNow(trackId) {
  playSong(trackId);
  closeBrowse();
}

function moveToFolder(trackId, { entry, anchor }) {
  if (!moveTrackToFolder(trackId, entry.arg)) anchor.focus();
}

// The menu has closed by now, so the dialog is told where focus goes back.
function renameSong(trackId, { anchor }) {
  openSongRename(trackId, { returnFocus: anchor });
}

function addToUpNext(trackId) {
  queueUpNext(trackId);
}

function stopExtracting(trackId) {
  cancelExtract(trackId);
}

function addToSetlist(trackId, { entry }) {
  addSongToSetlist(entry.arg, trackId);
}

function newSetlistWith(trackId) {
  createSetlistFrom([trackId]);
}

function restore(trackId) {
  restoreTracksFromTrash([trackId]);
}

/** Each action as `(trackId, { entry, item, anchor })`; the ones taking only `trackId` ignore the rest. */
export const SONG_ACTIONS = Object.freeze({
  [A.PLAY]: playNow,
  [A.UP_NEXT]: addToUpNext,
  [A.FAVORITE]: toggleFavorite,
  [A.RENAME]: renameSong,
  [A.EXTRACT]: extractMore,
  [A.STOP_EXTRACT]: stopExtracting,
  [A.ABOUT]: showAbout,
  [A.ADD_TO_SETLIST]: addToSetlist,
  [A.NEW_SETLIST]: newSetlistWith,
  [A.MOVE_TO_FOLDER]: moveToFolder,
  [A.NEW_FOLDER]: moveTrackToNewFolder,
  [A.TRASH]: trashWithUndo,
  [A.RESTORE]: restore,
  [A.CANCEL_IMPORT]: cancelImport,
  [A.RETRY]: retryFailedImport,
  [A.EXTRACT_AGAIN]: extractStoppedTrack,
});
