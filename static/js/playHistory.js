import { TRACK_OPEN_EVENT, TRASH_CHANGE_EVENT, getPlayingTrackInfo, isPlayableTrack, loadTrackIntoStudio } from "./catalog.js";
import { BACK, FORWARD, createStepHistory } from "./stepHistory.js";
import { NEXT_SOURCE, nextSong, previousPlayedId, previousSongId } from "./playOrder.js";
import { PLAY_CONTEXT_CHANGE_EVENT, nextInContext } from "./playContext.js";
import { onPlayStateChange } from "./playState.js";
import { UP_NEXT_CHANGE_EVENT, firstInUpNext, playNextInUpNext, playNow } from "./upNext.js";
import { restartSong, transport } from "./transport.js";
import { onLanguageChange, t } from "./i18n.js";
import { $ } from "./utils.js";

const played = createStepHistory();
const changeListeners = new Set();

function previousId() {
  return previousPlayedId(played, getPlayingTrackInfo()?.id, isPlayableTrack);
}

function upcoming() {
  return nextSong({
    forwardId: played.peek(FORWARD, isPlayableTrack),
    upNextId: firstInUpNext(),
    listId: nextInContext(),
  });
}

function openPlayed(trackId) {
  if (transport()?.isPlaying()) playNow(trackId);
  else loadTrackIntoStudio(trackId);
}

export function goToPrevious() {
  const position = transport()?.getCurrentTime() ?? 0;
  const backId = previousSongId(position, previousId());
  if (!backId) {
    restartSong();
    return;
  }
  if (backId !== played.current()) played.go(BACK, isPlayableTrack);
  openPlayed(backId);
}

function goForwardInHistory() {
  openPlayed(played.go(FORWARD, isPlayableTrack));
}

const PLAY_NEXT = Object.freeze({
  [NEXT_SOURCE.HISTORY]: goForwardInHistory,
  [NEXT_SOURCE.UP_NEXT]: playNextInUpNext,
  [NEXT_SOURCE.LIST]: playNow,
});

export function goToNext() {
  const next = upcoming();
  if (next) PLAY_NEXT[next.source](next.id);
}

export function canGoPrevious() {
  return Boolean(getPlayingTrackInfo());
}

export function canGoNext() {
  return Boolean(upcoming());
}

export function onPreviousNextChange(listener) {
  changeListeners.add(listener);
}

function paintPrevious() {
  const prev = $("t-prev");
  if (!prev) return;
  const label = t(previousId() ? "studio.footer.previousSong" : "studio.footer.previous");
  prev.disabled = !canGoPrevious();
  prev.title = label;
  prev.setAttribute("aria-label", label);
}

function paintPreviousNext() {
  paintPrevious();
  const next = $("t-next");
  if (next) next.disabled = !canGoNext();
  for (const listener of changeListeners) listener();
}

function onPlayState({ id, playing }) {
  if (playing) played.visit(id);
  paintPreviousNext();
}

export function initPlayHistory() {
  $("t-prev")?.addEventListener("click", goToPrevious);
  $("t-next")?.addEventListener("click", goToNext);
  onPlayStateChange(onPlayState);
  for (const name of [TRACK_OPEN_EVENT, UP_NEXT_CHANGE_EVENT, PLAY_CONTEXT_CHANGE_EVENT, TRASH_CHANGE_EVENT]) {
    document.addEventListener(name, paintPreviousNext);
  }
  onLanguageChange(paintPreviousNext);
  paintPreviousNext();
}
