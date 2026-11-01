// Stage mode: a full-window play-along view drawn over the lanes, so the studio keeps its size.
// F toggles it, Esc leaves it.

import { totalDuration } from "./state.js";
import { togglePlayPause, stopTransport, transport } from "./transport.js";
import { getSections, sectionDisplayName } from "./sections.js";
import { getCurrentTrackInfo } from "./catalog.js";
import { playNextInUpNext } from "./upNext.js";
import { shownBpm } from "./tempoTools.js";
import { isBeatGridEditing } from "./beatgrid.js";
import { refitFooter } from "./footerFit.js";
import { EMPTY_VALUE } from "./constants.js";
import { t, onLanguageChange } from "./i18n.js";
import { $, fmtTime } from "./utils.js";

const OPEN_MODAL = 'dialog[open], [role="dialog"][aria-modal="true"]';

let frameId = 0;
let sections = [];
let playObserver = null;
// Last values written, so a frame that changes nothing writes nothing.
const shown = { elapsed: "", total: "", section: "", next: "", playing: null };

export function isStageMode() {
  return document.querySelector(".app")?.classList.contains("stage-mode") ?? false;
}

function setText(el, key, text) {
  if (!el || shown[key] === text) return;
  shown[key] = text;
  el.textContent = text;
}

function readSections() {
  const all = getSections();
  sections = all.map((s) => ({ start: s.start, name: sectionDisplayName(s, all) }));
}

function sectionsAt(time) {
  const at = sections.findLastIndex((s) => s.start <= time);
  return { current: sections[at] ?? null, next: sections[at + 1] ?? null };
}

function nextLabel(time, next) {
  if (!sections.length) return EMPTY_VALUE;
  if (!next) return t("stage.lastSection");
  return t("stage.nextIn", { name: next.name, time: fmtTime(Math.max(0, next.start - time)) });
}

function isPlaying() {
  return Boolean(transport()?.isPlaying?.());
}

function paintFrame() {
  const time = transport()?.getCurrentTime?.() ?? 0;
  setText($("stageElapsed"), "elapsed", fmtTime(time));
  setText($("stageTotal"), "total", fmtTime(totalDuration || 0));

  const { current, next } = sectionsAt(time);
  setText($("stageSection"), "section", current?.name ?? "");
  setText($("stageNext"), "next", nextLabel(time, next));

  const playing = isPlaying();
  if (shown.playing !== playing) {
    shown.playing = playing;
    const play = $("stagePlayBtn");
    play?.classList.toggle("playing", playing);
    play?.setAttribute("aria-pressed", String(playing));
  }
}

function tick() {
  paintFrame();
  frameId = requestAnimationFrame(tick);
}

function stopLoop() {
  cancelAnimationFrame(frameId);
  frameId = 0;
}

/** Animate while playing; paused, draw the one frame that shows where it stopped. */
function syncLoop() {
  if (isPlaying()) {
    if (frameId) return;
    readSections();
    tick();
    return;
  }
  stopLoop();
  paintFrame();
}

function paintSong() {
  const info = getCurrentTrackInfo();
  $("stageTitle").textContent = info?.displayTitle || EMPTY_VALUE;
  $("stageArtist").textContent = info?.artist ?? "";
  paintTempo();
  readSections();
}

function paintTempo() {
  const bpm = shownBpm();
  $("stageTempo").textContent = bpm ? t("job.bpmValue", { bpm: bpm.toFixed(1) }) : EMPTY_VALUE;
}

function forgetPainted() {
  for (const key of Object.keys(shown)) shown[key] = key === "playing" ? null : "";
}

/** The footer's play button and time carry every play, pause and seek, whoever caused it. */
function watchPlayback() {
  playObserver ??= new MutationObserver(syncLoop);
  const play = $("t-play");
  const elapsed = $("footer-time-elapsed");
  if (play) playObserver.observe(play, { attributes: true, attributeFilter: ["class"] });
  if (elapsed) playObserver.observe(elapsed, { childList: true, characterData: true, subtree: true });
}

export function setStageMode(on) {
  const app = document.querySelector(".app");
  const view = $("stageView");
  if (!app || !view || isStageMode() === on) return;
  app.classList.toggle("stage-mode", on);
  view.hidden = !on;
  $("stageModeBtn")?.setAttribute("aria-pressed", String(on));
  refitFooter();
  if (on) {
    forgetPainted();
    paintSong();
    watchPlayback();
    syncLoop();
    $("stagePlayBtn")?.focus();
  } else {
    playObserver?.disconnect();
    stopLoop();
    $("stageModeBtn")?.focus();
  }
}

function keysBelongElsewhere(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return true;
  if (isBeatGridEditing()) return true;
  return [...document.querySelectorAll(OPEN_MODAL)].some((el) => el.getClientRects().length > 0);
}

function onStageKeydown(e) {
  if (keysBelongElsewhere(e)) return;
  if (e.code === "KeyF") {
    e.preventDefault();
    setStageMode(!isStageMode());
  } else if (e.key === "Escape" && isStageMode()) {
    setStageMode(false);
  }
}

function onStageToggleClick() {
  setStageMode(!isStageMode());
}

function onStageExitClick() {
  setStageMode(false);
}

function onSongChangeInStage() {
  if (!isStageMode()) return;
  forgetPainted();
  paintSong();
  syncLoop();
}

function onUpNextChange(e) {
  const next = $("stageNextBtn");
  if (next) next.disabled = !e.detail?.count;
}

export function initStageMode() {
  $("stageModeBtn")?.addEventListener("click", onStageToggleClick);
  $("stageExitBtn")?.addEventListener("click", onStageExitClick);
  $("stagePlayBtn")?.addEventListener("click", togglePlayPause);
  $("stageStopBtn")?.addEventListener("click", stopTransport);
  $("stageNextBtn")?.addEventListener("click", playNextInUpNext);
  window.addEventListener("keydown", onStageKeydown);
  document.addEventListener("trackopen", onSongChangeInStage);
  document.addEventListener("tracktags", onSongChangeInStage);
  document.addEventListener("upnext:change", onUpNextChange);
  document.addEventListener("tempochange", paintTempo);
  onLanguageChange(onSongChangeInStage);
}
