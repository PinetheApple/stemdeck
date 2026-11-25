import { firstInUpNext, setTrackEndOverride } from "./upNext.js";
import { transport } from "./transport.js";
import { countdownState } from "./stageSingModel.js";
import { focusStagePlay, stageSongNames } from "./stageUpNext.js";
import { t } from "./i18n.js";
import { $, fmtTickLabel } from "./utils.js";

const HANDOFF_MS = 5000;
const COUNTDOWN_TICK_MS = 100;
// Further from where the song ended than a clock's jitter: the user moved the playhead.
const SEEK_TOLERANCE_SEC = 0.25;
const HANDOFF_CLASS = "handoff";

let isActive = () => false;
let handoff = null;

function paintCountdown({ left, share }) {
  $("singRingNum").textContent = String(left);
  $("singRingLeft").style.strokeDashoffset = String(1 - share);
  const startsIn = t("sing.startsIn", { time: fmtTickLabel(left) });
  $("singRing").setAttribute("aria-label", startsIn);
  $("singStartsIn").textContent = startsIn;
}

function paintHandoffSong(nextId) {
  const { title, artist } = stageSongNames(nextId);
  $("singHandoffTitle").textContent = title;
  $("singHandoffArtist").textContent = artist;
}

function showHandoff(nextId, start) {
  paintHandoffSong(nextId);
  $("singHandoff").hidden = false;
  $("stageView")?.classList.add(HANDOFF_CLASS);
  handoff = {
    startedAt: performance.now(),
    endedAt: transport()?.getCurrentTime?.() ?? 0,
    timer: setInterval(onCountdownTick, COUNTDOWN_TICK_MS),
    start,
    followsUpNext: nextId === firstInUpNext(),
  };
  paintCountdown(countdownState(0, HANDOFF_MS));
  $("singPlayNowBtn")?.focus();
}

/** Ends the countdown, onto the next song with `advance`; focus leaves the card first unless `refocus` is false. */
function endHandoff({ advance, refocus = true }) {
  if (!handoff) return;
  const { start } = handoff;
  clearInterval(handoff.timer);
  handoff = null;
  const card = $("singHandoff");
  if (refocus && card.contains(document.activeElement)) focusStagePlay();
  card.hidden = true;
  $("stageView")?.classList.remove(HANDOFF_CLASS);
  if (advance) start();
}

function onCountdownTick() {
  const state = countdownState(performance.now() - handoff.startedAt, HANDOFF_MS);
  paintCountdown(state);
  if (state.done) endHandoff({ advance: true });
}

/** In Sing along a song's end shows what comes next before it starts. */
function onSongEnd(nextId, start) {
  if (!isActive() || !nextId) return false;
  endHandoff({ advance: false });
  showHandoff(nextId, start);
  return true;
}

/** A card for an Up Next song follows Up Next: another next song takes its place, and none closes it. */
function onUpNextChange(e) {
  if (!handoff?.followsUpNext) return;
  const nextId = e.detail?.nextId ?? null;
  if (nextId) paintHandoffSong(nextId);
  else endHandoff({ advance: false });
}

function onPlayNowClick() {
  endHandoff({ advance: true });
}

function onStayClick() {
  endHandoff({ advance: false });
}

/** Esc on the countdown is Stay here; false when there was none. */
export function dismissSingHandoff() {
  if (!handoff) return false;
  endHandoff({ advance: false });
  return true;
}

/** A playhead moved away from the song's end calls the countdown off. */
export function singPlayheadAt(time) {
  if (handoff && Math.abs(time - handoff.endedAt) > SEEK_TOLERANCE_SEC) endHandoff({ advance: false });
}

/** Leaving Sing along mid-countdown goes on to the next song, as Play along would have. */
export function singQueueLeaves() {
  endHandoff({ advance: true, refocus: false });
}

/** Another song opened, or this one plays again: the countdown has nothing left to do. */
export function singQueueSettles() {
  endHandoff({ advance: false });
}

/** `active()` says whether Sing along is on screen. */
export function initSingQueue({ active }) {
  isActive = active;
  $("singPlayNowBtn")?.addEventListener("click", onPlayNowClick);
  $("singStayBtn")?.addEventListener("click", onStayClick);
  document.addEventListener("upnext:change", onUpNextChange);
  setTrackEndOverride(onSongEnd);
}
