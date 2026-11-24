// Move to Trash with an Undo: the song goes back to its folder places and its
// Up Next place, and a song that was in the player opens again, paused where it was.

import {
  displayTitle, getLibraryTrack, getPlayingTrackInfo, libraryTitle, loadTrackIntoStudio, moveTrackToTrash,
  shownTrackId, undoTrash,
} from "./catalog.js";
import { insertUpNext, upNextIndexOf } from "./upNext.js";
import { setPlayheadTime, togglePlayPause, transport } from "./transport.js";
import { PLAYBACK_READY_EVENT } from "./player.js";
import { showUndo } from "./undoToast.js";
import { plural, t } from "./i18n.js";

const NOT_QUEUED = -1;

/** Where the player stood on the song, or null when it was not the player's. */
function playerPositionOf(trackId) {
  if (getPlayingTrackInfo()?.id !== trackId) return null;
  return transport()?.getCurrentTime?.() ?? 0;
}

/** Run `then` once the player has `trackId` ready; returns how to give up waiting. */
function whenReady(trackId, then) {
  function stopWaiting() {
    document.removeEventListener(PLAYBACK_READY_EVENT, onPlaybackReady);
  }
  function onPlaybackReady(e) {
    if (e.detail?.id !== trackId) return;
    stopWaiting();
    then();
  }
  document.addEventListener(PLAYBACK_READY_EVENT, onPlaybackReady);
  return stopWaiting;
}

function pauseAt(seconds) {
  if (transport()?.isPlaying()) togglePlayPause();
  setPlayheadTime(seconds);
}

async function reopenPaused(trackId, seconds) {
  if (getPlayingTrackInfo()?.id === trackId) {
    pauseAt(seconds);
    return;
  }
  const stopWaiting = whenReady(trackId, function onReopened() {
    pauseAt(seconds);
  });
  // A load can resolve before the engine is ready; the ready event then places it again.
  if (await loadTrackIntoStudio(trackId)) pauseAt(seconds);
  else stopWaiting();
}

function binForUndo(trackId) {
  const queuedAt = upNextIndexOf(trackId);
  const position = playerPositionOf(trackId);
  return { trackId, queuedAt, position, place: moveTrackToTrash(trackId) };
}

function putBack({ trackId, queuedAt, position, place }, movedOn) {
  undoTrash(trackId, place);
  if (queuedAt !== NOT_QUEUED) insertUpNext(trackId, queuedAt);
  if (position !== null && !movedOn) reopenPaused(trackId, position);
}

function trashedMessage(binned) {
  if (binned.length > 1) return plural("libSort.movedToTrash", binned.length);
  return t("lib.movedToTrash", { title: displayTitle(libraryTitle(getLibraryTrack(binned[0].trackId))) });
}

/** Trash every song in `trackIds`, with one Undo that puts them all back. */
export function trashAllWithUndo(trackIds) {
  const binned = trackIds.filter(getLibraryTrack).map(binForUndo);
  if (!binned.length) return;
  const shownAfterTrash = shownTrackId();
  showUndo(trashedMessage(binned), function onUndoTrash() {
    // A song opened or played since the trash keeps the studio; the trashed ones only return to the library.
    const movedOn = Boolean(getPlayingTrackInfo()) || shownTrackId() !== shownAfterTrash;
    // Last binned first, so each Up Next place is taken back in the queue it was taken from.
    for (const entry of [...binned].reverse()) putBack(entry, movedOn);
  });
}

export function trashWithUndo(trackId) {
  trashAllWithUndo([trackId]);
}
