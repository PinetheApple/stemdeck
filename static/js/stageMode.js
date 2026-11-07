// Stage mode: a full-window play-along view drawn over the lanes, so the studio keeps its size.
// F toggles it, Esc leaves it.

import { metronomeBeatsPerBar, npScrubFill } from "./state.js";
import { togglePlayPause, stopTransport, transport } from "./transport.js";
import { getSections, sectionDisplayName } from "./sections.js";
import { getCurrentTrackInfo } from "./catalog.js";
import { playNextInUpNext } from "./upNext.js";
import { shownBpm } from "./tempoTools.js";
import { isBeatGridEditing, getBeats, barPositionIndex, barLengthAt } from "./beatgrid.js";
import { buildBeatTable, beatAt } from "./stageBeats.js";
import { ensureLyricsLoaded, getTimedLyricLines, tagLang } from "./lyrics.js";
import { currentLineIndex } from "./lyricsLookup.js";
import { refitFooter } from "./footerFit.js";
import { EMPTY_VALUE } from "./constants.js";
import { t, onLanguageChange } from "./i18n.js";
import { $, fmtTime } from "./utils.js";

const OPEN_MODAL = 'dialog[open], [role="dialog"][aria-modal="true"]';
// As lyrics.js: a seek lands on a line's stamp, and the time read back can be a hair before it.
const LYRIC_LEAD_SEC = 0.05;
const GAP_LINE = "♪";

let frameId = 0;
let sections = [];
let beatTable = [];
let playObserver = null;
// Last values written, so a frame that changes nothing writes nothing.
const shown = {
  section: null, next: null, playing: null,
  count: null, dotCount: null, dotOn: null, hasLyrics: null, lyric: null, nextLyric: null,
};

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

function readBeatTable() {
  const fallbackLength = metronomeBeatsPerBar > 0 ? metronomeBeatsPerBar : barLengthAt(0);
  beatTable = buildBeatTable(getBeats(), barPositionIndex, fallbackLength);
}

function paintDots(length, onIndex) {
  const dots = $("stageBeats");
  if (!dots) return;
  if (shown.dotCount !== length) {
    shown.dotCount = length;
    shown.dotOn = null;
    dots.replaceChildren(...Array.from({ length }, () => document.createElement("i")));
  }
  if (shown.dotOn === onIndex) return;
  shown.dotOn = onIndex;
  [...dots.children].forEach((dot, i) => {
    dot.classList.toggle("on", i === onIndex);
    dot.classList.toggle("down", i === 0);
  });
}

function paintBeat(time) {
  const at = beatAt(beatTable, time);
  setText($("stageCount"), "count", at ? `${at.bar}.${at.beat}` : EMPTY_VALUE);
  paintDots(at?.length ?? beatTable[0]?.length ?? 0, at ? at.beat - 1 : null);
}

function setLyric(el, key, text) {
  if (!el || shown[key] === text) return;
  setText(el, key, text);
  el.removeAttribute("lang");
  tagLang(el, text);
}

const lineText = (line) => (line ? line.text || GAP_LINE : "");

function paintLyrics(time) {
  const lines = getTimedLyricLines();
  const hasLyrics = lines.length > 0;
  if (shown.hasLyrics !== hasLyrics) {
    shown.hasLyrics = hasLyrics;
    $("stageLyrics").hidden = !hasLyrics;
  }
  const index = currentLineIndex(lines, time + LYRIC_LEAD_SEC);
  setLyric($("stageLyric"), "lyric", lineText(lines[index]));
  setLyric($("stageLyricNext"), "nextLyric", lineText(lines[index + 1]));
}

function isPlaying() {
  return Boolean(transport()?.isPlaying?.());
}

function paintFrame() {
  const time = transport()?.getCurrentTime?.() ?? 0;
  const { current, next } = sectionsAt(time);
  setText($("stageSection"), "section", current?.name ?? "");
  setText($("stageNext"), "next", nextLabel(time, next));
  paintBeat(time);
  paintLyrics(time);

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
  readBeatTable();
  ensureLyricsLoaded();
}

function paintTempo() {
  const bpm = shownBpm();
  $("stageTempo").textContent = bpm ? t("job.bpmValue", { bpm: bpm.toFixed(1) }) : EMPTY_VALUE;
}

function forgetPainted() {
  for (const key of Object.keys(shown)) shown[key] = null;
}

function onTempoChange() {
  paintTempo();
  if (!isStageMode()) return;
  readBeatTable();
  paintFrame();
}

function onLyricsChange() {
  if (isStageMode()) paintFrame();
}

/**
 * The footer's play button and scrub fill carry every play, pause and seek, whoever caused it.
 * Not its time text, which stays put for a seek inside the same second.
 */
function watchPlayback() {
  playObserver ??= new MutationObserver(syncLoop);
  const play = $("t-play");
  if (play) playObserver.observe(play, { attributes: true, attributeFilter: ["class"] });
  if (npScrubFill) playObserver.observe(npScrubFill, { attributes: true, attributeFilter: ["style"] });
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
  document.addEventListener("tracklookup", onSongChangeInStage);
  document.addEventListener("upnext:change", onUpNextChange);
  document.addEventListener("tempochange", onTempoChange);
  document.addEventListener("lyricschange", onLyricsChange);
  onLanguageChange(onSongChangeInStage);
}
