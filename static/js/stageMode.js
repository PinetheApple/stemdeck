// Stage mode: a full-window play-along view drawn over the lanes, so the studio keeps its size.
// F toggles it, Esc leaves it.

import { metronomeBeatsPerBar, npScrubFill, totalDuration } from "./state.js";
import { togglePlayPause, stopTransport, transport } from "./transport.js";
import { getSections, sectionDisplayName } from "./sections.js";
import { getPlayingTrackInfo, isTextEditingTarget } from "./catalog.js";
import { playNextInUpNext } from "./upNext.js";
import { shownBpm } from "./tempoTools.js";
import { isBeatGridEditing, getBeats, barPositionIndex, barLengthAt } from "./beatgrid.js";
import { buildBeatTable, beatAt } from "./stageBeats.js";
import { ensureLyricsLoaded, getTimedLyricLines } from "./lyrics.js";
import { currentLineIndex } from "./lyricsLookup.js";
import { refitFooter } from "./footerFit.js";
import { initStageMixer, paintStageMixer, forgetStageMixer } from "./stageMixer.js";
import { initStageOverview, paintStageOverview, paintStageSections, forgetStageOverview } from "./stageOverview.js";
import { LYRIC_LEAD_SEC, setTextOnce } from "./stageModel.js";
import { lineText, setLyric } from "./stageLyricLine.js";
import { DURATION_EVENT } from "./player.js";
import {
  forgetSingPainted,
  initSingAlong,
  isSingAlong,
  paintSingFrame,
  singSongChange,
  singStageShown,
} from "./stageSingAlong.js";
import { closeSingPanel, dismissSingHandoff, singPlayheadAt, singQueueSettles } from "./stageSingQueue.js";
import { EMPTY_VALUE } from "./constants.js";
import { t, onLanguageChange } from "./i18n.js";
import { $, fmtTime } from "./utils.js";

const OPEN_MODAL = 'dialog[open], [role="dialog"][aria-modal="true"]';

let frameId = 0;
let sections = [];
let sectionsKey = "";
let beatTable = [];
let playObserver = null;
// Last values written, so a frame that changes nothing writes nothing.
const shown = {
  section: null, next: null, playing: null,
  dotCount: null, dotOn: null, hasLyrics: null, lyric: null, nextLyric: null,
};

export function isStageMode() {
  return document.querySelector(".app")?.classList.contains("stage-mode") ?? false;
}

function readSections() {
  const all = getSections();
  sections = all.map((s) => ({ start: s.start, end: s.end, name: sectionDisplayName(s, all) }));
  const key = JSON.stringify([totalDuration, sections]);
  if (key === sectionsKey) return;
  sectionsKey = key;
  paintStageSections(sections);
}

function sectionsAt(time) {
  const at = sections.findLastIndex((s) => s.start <= time);
  return { at, current: sections[at] ?? null, next: sections[at + 1] ?? null };
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
  paintDots(at?.length ?? beatTable[0]?.length ?? 0, at ? at.beat - 1 : null);
}

function paintLyrics(time) {
  const lines = getTimedLyricLines();
  const hasLyrics = lines.length > 0;
  if (shown.hasLyrics !== hasLyrics) {
    shown.hasLyrics = hasLyrics;
    $("stageLyrics").hidden = !hasLyrics;
  }
  const index = currentLineIndex(lines, time + LYRIC_LEAD_SEC);
  setLyric(shown, "lyric", $("stageLyric"), lineText(lines[index]));
  setLyric(shown, "nextLyric", $("stageLyricNext"), lineText(lines[index + 1]));
}

function isPlaying() {
  return Boolean(transport()?.isPlaying?.());
}

function paintFrame() {
  const time = transport()?.getCurrentTime?.() ?? 0;
  const { at, current, next } = sectionsAt(time);
  setTextOnce(shown, "section", $("stageSection"), current?.name ?? "");
  setTextOnce(shown, "next", $("stageNext"), nextLabel(time, next));
  paintStageOverview(time, at);
  paintBeat(time);
  paintLyrics(time);
  if (isSingAlong()) paintSingFrame(time);
  singPlayheadAt(time);

  const playing = isPlaying();
  if (shown.playing !== playing) {
    shown.playing = playing;
    if (playing) singQueueSettles();
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
  readSections();
  paintFrame();
}

function paintSong() {
  const info = getPlayingTrackInfo();
  $("stageTitle").textContent = info?.displayTitle || EMPTY_VALUE;
  $("stageArtist").textContent = info?.artist ?? "";
  paintTempo();
  readSections();
  readBeatTable();
  ensureLyricsLoaded();
  paintStageMixer();
}

function paintTempo() {
  const bpm = shownBpm();
  $("stageTempo").textContent = bpm ? t("job.bpmValue", { bpm: bpm.toFixed(1) }) : EMPTY_VALUE;
}

function forgetPainted() {
  for (const key of Object.keys(shown)) shown[key] = null;
  sectionsKey = "";
  forgetStageOverview();
  forgetStageMixer();
  forgetSingPainted();
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

function onDurationKnown() {
  if (isStageMode()) syncLoop();
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
  singStageShown(on);
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

export function isModalOpen() {
  return [...document.querySelectorAll(OPEN_MODAL)].some((el) => el.getClientRects().length > 0);
}

function keysBelongElsewhere(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return true;
  if (isTextEditingTarget(e.target)) return true;
  if (isBeatGridEditing()) return true;
  return isModalOpen();
}

function onStageKeydown(e) {
  if (keysBelongElsewhere(e)) return;
  if (e.code === "KeyF") {
    e.preventDefault();
    setStageMode(!isStageMode());
  } else if (e.key === "Escape" && isStageMode()) {
    if (!dismissSingHandoff() && !closeSingPanel()) setStageMode(false);
  }
}

function onStageToggleClick() {
  setStageMode(!isStageMode());
}

function onStageExitClick() {
  setStageMode(false);
}

function redrawStage() {
  forgetPainted();
  paintSong();
  syncLoop();
}

function onSongChangeInStage() {
  if (!isStageMode()) return;
  singSongChange();
  redrawStage();
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
  initStageMixer(isStageMode);
  initStageOverview(isStageMode);
  initSingAlong({ showing: isStageMode, redraw: redrawStage, leaveStage: onStageExitClick });
  window.addEventListener("keydown", onStageKeydown);
  document.addEventListener("trackopen", onSongChangeInStage);
  document.addEventListener("tracktags", onSongChangeInStage);
  document.addEventListener("tracklookup", onSongChangeInStage);
  document.addEventListener("upnext:change", onUpNextChange);
  document.addEventListener("tempochange", onTempoChange);
  document.addEventListener("lyricschange", onLyricsChange);
  document.addEventListener(DURATION_EVENT, onDurationKnown);
  onLanguageChange(onSongChangeInStage);
}
