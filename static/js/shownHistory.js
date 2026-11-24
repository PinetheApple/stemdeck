// Back and Forward in the song header, and Alt+Left/Right: the songs shown in the
// studio, stepped through like a browser's history. They change what is shown, never what plays.

import { TRACK_SHOW_EVENT, TRASH_CHANGE_EVENT, isPlayableTrack, isTextEditingTarget } from "./catalog.js";
import { openSong } from "./openSong.js";
import { topLayer } from "./shellEscape.js";
import { BACK, FORWARD, createStepHistory } from "./stepHistory.js";
import { $ } from "./utils.js";

const STEP_KEYS = Object.freeze({ ArrowLeft: BACK, ArrowRight: FORWARD });
const shown = createStepHistory();

function paintBackForward() {
  const back = $("songBackBtn");
  const forward = $("songForwardBtn");
  if (back) back.disabled = !shown.peek(BACK, isPlayableTrack);
  if (forward) forward.disabled = !shown.peek(FORWARD, isPlayableTrack);
}

function showStep(step) {
  const trackId = shown.go(step, isPlayableTrack);
  if (trackId) openSong(trackId);
  paintBackForward();
}

function onSongShown(e) {
  shown.visit(e.detail?.id);
  paintBackForward();
}

function onSongBackClick() {
  showStep(BACK);
}

function onSongForwardClick() {
  showStep(FORWARD);
}

// Not while typing, nor over a dialog, a menu or Stage, which show no song header.
function onBackForwardKey(e) {
  const step = STEP_KEYS[e.key];
  if (!step || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
  if (isTextEditingTarget(e.target) || topLayer()) return;
  e.preventDefault();
  showStep(step);
}

export function initShownHistory() {
  $("songBackBtn")?.addEventListener("click", onSongBackClick);
  $("songForwardBtn")?.addEventListener("click", onSongForwardClick);
  document.addEventListener("trackopen", onSongShown);
  document.addEventListener(TRACK_SHOW_EVENT, onSongShown);
  document.addEventListener(TRASH_CHANGE_EVENT, paintBackForward);
  document.addEventListener("keydown", onBackForwardKey);
  paintBackForward();
}
