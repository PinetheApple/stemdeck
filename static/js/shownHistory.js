import { TRACK_SHOW_EVENT, TRASH_CHANGE_EVENT, isPlayableTrack, isTextEditingTarget } from "./catalog.js";
import { openSong } from "./openSong.js";
import { TRACK_OPEN_EVENT } from "./playHistory.js";
import { topLayer } from "./shellEscape.js";
import { BACK, FORWARD, createStepHistory } from "./stepHistory.js";
import { $ } from "./utils.js";

const STEP_KEYS = Object.freeze({ ArrowLeft: BACK, ArrowRight: FORWARD });
const shown = createStepHistory();
let pendingStep = null;

function paintBackForward() {
  const back = $("songBackBtn");
  const forward = $("songForwardBtn");
  if (back) back.disabled = !shown.peek(BACK, isPlayableTrack);
  if (forward) forward.disabled = !shown.peek(FORWARD, isPlayableTrack);
}

// The place moves once the song is on screen: openSong does nothing mid-take or while it loads.
function showStep(step) {
  const trackId = shown.peek(step, isPlayableTrack);
  if (!trackId) return;
  pendingStep = { step, trackId };
  openSong(trackId);
}

function onSongShown(e) {
  const trackId = e.detail?.id;
  if (pendingStep?.trackId === trackId) shown.go(pendingStep.step, isPlayableTrack);
  else shown.visit(trackId);
  pendingStep = null;
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
  document.addEventListener(TRACK_OPEN_EVENT, onSongShown);
  document.addEventListener(TRACK_SHOW_EVENT, onSongShown);
  document.addEventListener(TRASH_CHANGE_EVENT, paintBackForward);
  document.addEventListener("keydown", onBackForwardKey);
  paintBackForward();
}
