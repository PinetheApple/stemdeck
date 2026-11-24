// Move to Trash with an Undo: the song goes back to its folder places and its
// Up Next place, and a song that was in the player opens again, paused where it was.

import {
  displayTitle, getLibraryTrack, getPlayingTrackInfo, libraryTitle, loadTrackIntoStudio, moveTrackToTrash, undoTrash,
} from "./catalog.js";
import { getNowAndUpNextIds, insertUpNext } from "./upNext.js";
import { setPlayheadTime, togglePlayPause, transport } from "./transport.js";
import { showUndo } from "./undoToast.js";
import { t } from "./i18n.js";

const NOT_QUEUED = -1;
const READY_EVENT = "playbackready";

/** The song's place in Up Next, not counting the song in the player. */
function upNextIndexOf(trackId) {
  const ids = getNowAndUpNextIds();
  const queued = ids[0] === getPlayingTrackInfo()?.id ? ids.slice(1) : ids;
  return queued.indexOf(trackId);
}

/** Where the player stood on the song, or null when it was not the player's. */
function playerPositionOf(trackId) {
  if (getPlayingTrackInfo()?.id !== trackId) return null;
  return transport()?.getCurrentTime?.() ?? 0;
}

function whenReady(trackId, then) {
  document.addEventListener(READY_EVENT, function onPlaybackReady(e) {
    if (e.detail?.id !== trackId) return;
    document.removeEventListener(READY_EVENT, onPlaybackReady);
    then();
  });
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
  whenReady(trackId, function onReopened() {
    pauseAt(seconds);
  });
  await loadTrackIntoStudio(trackId);
}

/** Move the song to the Trash and offer to take it back. */
export function trashWithUndo(trackId) {
  const track = getLibraryTrack(trackId);
  if (!track) return;
  const queuedAt = upNextIndexOf(trackId);
  const position = playerPositionOf(trackId);
  const place = moveTrackToTrash(trackId);
  showUndo(t("lib.movedToTrash", { title: displayTitle(libraryTitle(track)) }), function onUndoTrash() {
    undoTrash(trackId, place);
    if (queuedAt !== NOT_QUEUED) insertUpNext(trackId, queuedAt);
    if (position !== null) reopenPaused(trackId, position);
  });
}
