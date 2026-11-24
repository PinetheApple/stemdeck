// The footer's Previous and Next: the songs played this session, walked like a
// browser's history, then Up Next, then the list the playing song was started from.

import { TRASH_CHANGE_EVENT, getPlayingTrackInfo, isPlayableTrack, loadTrackIntoStudio } from "./catalog.js";
import { BACK, FORWARD, createStepHistory } from "./stepHistory.js";
import { NEXT_SOURCE, nextSong, previousSongId } from "./playOrder.js";
import { PLAY_CONTEXT_CHANGE_EVENT, nextInContext } from "./playContext.js";
import { UP_NEXT_CHANGE_EVENT, firstInUpNext, playNextInUpNext, playNow } from "./upNext.js";
import { restartSong, transport } from "./transport.js";
import { onLanguageChange, t } from "./i18n.js";
import { $ } from "./utils.js";

const played = createStepHistory();

function upcoming() {
  return nextSong({
    forwardId: played.peek(FORWARD, isPlayableTrack),
    upNextId: firstInUpNext(),
    listId: nextInContext(),
  });
}

/** Walk the history without adding to it; the player keeps playing or stays paused. */
function stepPlayed(step) {
  const wasPlaying = transport()?.isPlaying() === true;
  const trackId = played.go(step, isPlayableTrack);
  if (wasPlaying) playNow(trackId);
  else loadTrackIntoStudio(trackId);
}

export function goToPrevious() {
  const position = transport()?.getCurrentTime() ?? 0;
  if (previousSongId(position, played.peek(BACK, isPlayableTrack))) stepPlayed(BACK);
  else restartSong();
}

const PLAY_NEXT = Object.freeze({
  [NEXT_SOURCE.HISTORY]: () => stepPlayed(FORWARD),
  [NEXT_SOURCE.UP_NEXT]: playNextInUpNext,
  [NEXT_SOURCE.LIST]: playNow,
});

export function goToNext() {
  const next = upcoming();
  if (next) PLAY_NEXT[next.source](next.id);
}

function paintPrevious() {
  const prev = $("t-prev");
  if (!prev) return;
  const label = t(played.peek(BACK, isPlayableTrack) ? "studio.footer.previousSong" : "studio.footer.previous");
  prev.disabled = !getPlayingTrackInfo();
  prev.title = label;
  prev.setAttribute("aria-label", label);
}

function paintPreviousNext() {
  paintPrevious();
  const next = $("t-next");
  if (next) next.disabled = !upcoming();
}

function onPlayerSongOpen(e) {
  played.visit(e.detail?.id);
  paintPreviousNext();
}

export function initPlayHistory() {
  $("t-prev")?.addEventListener("click", goToPrevious);
  $("t-next")?.addEventListener("click", goToNext);
  document.addEventListener("trackopen", onPlayerSongOpen);
  for (const name of [UP_NEXT_CHANGE_EVENT, PLAY_CONTEXT_CHANGE_EVENT, TRASH_CHANGE_EVENT]) {
    document.addEventListener(name, paintPreviousNext);
  }
  onLanguageChange(paintPreviousNext);
  paintPreviousNext();
}
