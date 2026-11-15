// Sing along's Up Next: a chip for the next song, the studio's own Up Next list lent to a
// side panel, and a short countdown before the next song when one ends.

import { displayTitle, getTrackNames } from "./catalog.js";
import { playNextInUpNext, setTrackEndOverride } from "./upNext.js";
import { transport } from "./transport.js";
import { countdownState } from "./stageSingModel.js";
import { t } from "./i18n.js";
import { $, fmtTickLabel } from "./utils.js";

const HANDOFF_MS = 5000;
const COUNTDOWN_TICK_MS = 100;
// Further from where the song ended than a clock's jitter: the user moved the playhead.
const SEEK_TOLERANCE_SEC = 0.25;
const HANDOFF_CLASS = "handoff";
const BORROW_SLOT = "[data-borrow]";
const FOCUSED_ROW = "#upNextList .upnext-row[tabindex='0']";

let isActive = () => false;
let upNext = { count: 0, nextId: null };
let borrowed = [];
let handoff = null;

function songNames(id) {
  const names = getTrackNames(id);
  return { title: displayTitle(names?.title), artist: names?.artist ?? "" };
}

const isPanelOpen = () => $("singPanel")?.hidden === false;
const playButton = () => $("stagePlayBtn");

function paintChip() {
  const chip = $("singUpNextBtn");
  if (!chip) return;
  chip.hidden = !upNext.count;
  chip.setAttribute("aria-expanded", String(isPanelOpen()));
  $("singUpNextCount").textContent = String(upNext.count);
  $("singUpNextTitle").textContent = upNext.nextId ? songNames(upNext.nextId).title : "";
}

/** Moves a studio node into the panel, leaving a marker where it goes back to. */
function borrowInto(slot) {
  const node = $(slot.dataset.borrow);
  if (!node) return;
  const marker = document.createComment(slot.dataset.borrow);
  node.replaceWith(marker);
  slot.append(node);
  borrowed.push({ node, marker });
}

function giveBack() {
  for (const { node, marker } of borrowed.splice(0)) marker.replaceWith(node);
}

function openPanel() {
  const panel = $("singPanel");
  if (!panel || isPanelOpen()) return;
  panel.querySelectorAll(BORROW_SLOT).forEach(borrowInto);
  panel.hidden = false;
  paintChip();
  (document.querySelector(FOCUSED_ROW) ?? $("singPanelClose"))?.focus();
}

/** Closes the Up Next panel, focus going back to the chip unless `refocus` is false; false when it was not open. */
export function closeSingPanel({ refocus = true } = {}) {
  if (!isPanelOpen()) return false;
  if (refocus) {
    const chip = $("singUpNextBtn");
    (chip && !chip.hidden ? chip : playButton())?.focus();
  }
  giveBack();
  $("singPanel").hidden = true;
  paintChip();
  return true;
}

function onPanelCloseClick() {
  closeSingPanel();
}

function onChipClick() {
  if (isPanelOpen()) closeSingPanel();
  else openPanel();
}

function paintCountdown({ left, share }) {
  $("singRingNum").textContent = String(left);
  $("singRingLeft").style.strokeDashoffset = String(1 - share);
  $("singRing").setAttribute("aria-label", t("sing.startsIn", { time: fmtTickLabel(left) }));
}

function paintHandoffSong(nextId) {
  const { title, artist } = songNames(nextId);
  $("singHandoffTitle").textContent = title;
  $("singHandoffArtist").textContent = artist;
}

function showHandoff(nextId) {
  paintHandoffSong(nextId);
  $("singHandoff").hidden = false;
  $("stageView")?.classList.add(HANDOFF_CLASS);
  handoff = {
    startedAt: performance.now(),
    endedAt: transport()?.getCurrentTime?.() ?? 0,
    timer: setInterval(onCountdownTick, COUNTDOWN_TICK_MS),
  };
  paintCountdown(countdownState(0, HANDOFF_MS));
  $("singPlayNowBtn")?.focus();
}

/** Ends the countdown, onto the next song with `advance`; focus leaves the card first unless `refocus` is false. */
function endHandoff({ advance, refocus = true }) {
  if (!handoff) return;
  clearInterval(handoff.timer);
  handoff = null;
  const card = $("singHandoff");
  if (refocus && card.contains(document.activeElement)) playButton()?.focus();
  card.hidden = true;
  $("stageView")?.classList.remove(HANDOFF_CLASS);
  if (advance) playNextInUpNext();
}

function onCountdownTick() {
  const state = countdownState(performance.now() - handoff.startedAt, HANDOFF_MS);
  paintCountdown(state);
  if (state.done) endHandoff({ advance: true });
}

/** In Sing along a song's end shows what comes next before it starts. */
function onSongEnd(nextId) {
  if (!isActive() || !nextId) return false;
  endHandoff({ advance: false });
  showHandoff(nextId);
  return true;
}

/** The card follows Up Next: another next song takes its place, and none closes it. */
function onUpNextChange(e) {
  upNext = { count: e.detail?.count ?? 0, nextId: e.detail?.nextId ?? null };
  paintChip();
  if (!handoff) return;
  if (upNext.nextId) paintHandoffSong(upNext.nextId);
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
  closeSingPanel({ refocus: false });
  endHandoff({ advance: true, refocus: false });
}

/** Another song opened, or this one plays again: the countdown has nothing left to do. */
export function singQueueSettles() {
  endHandoff({ advance: false });
}

/** `active()` says whether Sing along is on screen. */
export function initSingQueue({ active }) {
  isActive = active;
  $("singUpNextBtn")?.addEventListener("click", onChipClick);
  $("singPanelClose")?.addEventListener("click", onPanelCloseClick);
  $("singPlayNowBtn")?.addEventListener("click", onPlayNowClick);
  $("singStayBtn")?.addEventListener("click", onStayClick);
  document.addEventListener("upnext:change", onUpNextChange);
  setTrackEndOverride(onSongEnd);
}
