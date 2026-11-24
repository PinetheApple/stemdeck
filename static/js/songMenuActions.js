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
function extractMore(trackId, anchor) {
  if (isStageMode()) setStageMode(false);
  revealSongRows();
  document.dispatchEvent(new CustomEvent("versions:extract", { detail: { id: trackId, anchor } }));
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

/** Each action as `(trackId, { entry, item, anchor })`. */
export const SONG_ACTIONS = Object.freeze({
  [A.PLAY]: playNow,
  [A.UP_NEXT]: queueUpNext,
  [A.FAVORITE]: toggleFavorite,
  [A.RENAME]: openSongRename,
  [A.EXTRACT]: (trackId, { anchor }) => extractMore(trackId, anchor),
  [A.STOP_EXTRACT]: (trackId) => cancelExtract(trackId),
  [A.ABOUT]: showAbout,
  [A.ADD_TO_SETLIST]: (trackId, { entry }) => addSongToSetlist(entry.arg, trackId),
  [A.NEW_SETLIST]: (trackId) => createSetlistFrom([trackId]),
  [A.MOVE_TO_FOLDER]: moveToFolder,
  [A.NEW_FOLDER]: moveTrackToNewFolder,
  [A.TRASH]: trashWithUndo,
  [A.RESTORE]: (trackId) => restoreTracksFromTrash([trackId]),
  [A.CANCEL_IMPORT]: cancelImport,
  [A.RETRY]: retryFailedImport,
  [A.EXTRACT_AGAIN]: extractStoppedTrack,
});
