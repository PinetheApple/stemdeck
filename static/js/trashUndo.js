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
import { t } from "./i18n.js";

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

export function trashWithUndo(trackId) {
  const track = getLibraryTrack(trackId);
  if (!track) return;
  const queuedAt = upNextIndexOf(trackId);
  const position = playerPositionOf(trackId);
  const place = moveTrackToTrash(trackId);
  const shownAfterTrash = shownTrackId();
  showUndo(t("lib.movedToTrash", { title: displayTitle(libraryTitle(track)) }), function onUndoTrash() {
    // A song opened or played since the trash keeps the studio; the trashed one only returns to the library.
    const movedOn = Boolean(getPlayingTrackInfo()) || shownTrackId() !== shownAfterTrash;
    undoTrash(trackId, place);
    if (queuedAt !== NOT_QUEUED) insertUpNext(trackId, queuedAt);
    if (position !== null && !movedOn) reopenPaused(trackId, position);
  });
}
