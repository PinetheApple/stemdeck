// Sing along's Up Next: a chip for the next song, the studio's own Up Next list lent to a
// side panel, and a short countdown before the next song when one ends.

import { displayTitle, getTrackNames } from "./catalog.js";
import { playNextInUpNext, setTrackEndOverride } from "./upNext.js";
import { countdownState } from "./stageSingModel.js";
import { t } from "./i18n.js";
import { $, fmtTickLabel } from "./utils.js";

const HANDOFF_MS = 5000;
const COUNTDOWN_TICK_MS = 100;
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

function paintChip() {
  const chip = $("singUpNextBtn");
  if (!chip) return;
  chip.hidden = !upNext.count || isPanelOpen();
  chip.setAttribute("aria-expanded", String(isPanelOpen()));
  $("singUpNextCount").textContent = String(upNext.count);
  $("singUpNextTitle").textContent = upNext.nextId ? songNames(upNext.nextId).title : "";
}

function onUpNextChange(e) {
  upNext = { count: e.detail?.count ?? 0, nextId: e.detail?.nextId ?? null };
  paintChip();
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

/** Closes the Up Next panel; false when it was not open. */
export function closeSingPanel() {
  if (!isPanelOpen()) return false;
  giveBack();
  $("singPanel").hidden = true;
  paintChip();
  const chip = $("singUpNextBtn");
  (chip && !chip.hidden ? chip : $("stagePlayBtn"))?.focus();
  return true;
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

function showHandoff(nextId) {
  const { title, artist } = songNames(nextId);
  $("singHandoffTitle").textContent = title;
  $("singHandoffArtist").textContent = artist;
  $("singHandoff").hidden = false;
  $("stageView")?.classList.add(HANDOFF_CLASS);
  handoff = { startedAt: performance.now(), timer: setInterval(onCountdownTick, COUNTDOWN_TICK_MS) };
  paintCountdown(countdownState(0, HANDOFF_MS));
  $("singPlayNowBtn")?.focus();
}

function endHandoff(advance) {
  if (!handoff) return;
  clearInterval(handoff.timer);
  handoff = null;
  $("singHandoff").hidden = true;
  $("stageView")?.classList.remove(HANDOFF_CLASS);
  if (advance) playNextInUpNext();
}

function onCountdownTick() {
  const state = countdownState(performance.now() - handoff.startedAt, HANDOFF_MS);
  paintCountdown(state);
  if (state.done) endHandoff(true);
}

/** In Sing along a song's end shows what comes next before it starts. */
function onSongEnd(nextId) {
  if (!isActive() || !nextId) return false;
  endHandoff(false);
  showHandoff(nextId);
  return true;
}

function onPlayNowClick() {
  endHandoff(true);
}

function onStayClick() {
  endHandoff(false);
  $("stagePlayBtn")?.focus();
}

/** Leaving Sing along mid-countdown goes on to the next song, as Play along would have. */
export function singQueueLeaves() {
  closeSingPanel();
  endHandoff(true);
}

/** Another song opened, or this one plays again: the countdown has nothing left to do. */
export function singQueueSettles() {
  endHandoff(false);
}

/** `active()` says whether Sing along is on screen. */
export function initSingQueue({ active }) {
  isActive = active;
  $("singUpNextBtn")?.addEventListener("click", onChipClick);
  $("singPanelClose")?.addEventListener("click", closeSingPanel);
  $("singPlayNowBtn")?.addEventListener("click", onPlayNowClick);
  $("singStayBtn")?.addEventListener("click", onStayClick);
  document.addEventListener("upnext:change", onUpNextChange);
  setTrackEndOverride(onSongEnd);
}
