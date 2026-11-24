// Stage mode: a play-along view over the top bar and the studio, played from the footer below it.
// F toggles it, Esc leaves it.

import { metronomeBeatsPerBar, npScrubFill } from "./state.js";
import { transport } from "./transport.js";
import { getPlayingTrackInfo, isTextEditingTarget } from "./catalog.js";
import { shownBpm } from "./tempoTools.js";
import { isBeatGridEditing, getBeats, barPositionIndex, barLengthAt } from "./beatgrid.js";
import { buildBeatTable, beatAt } from "./stageBeats.js";
import { ensureLyricsLoaded, getTimedLyricLines } from "./lyrics.js";
import { currentLineIndex } from "./lyricsLookup.js";
import { refitFooter } from "./footerFit.js";
import { initStageMixer, paintStageMixer, paintStageMeters, forgetStageMixer } from "./stageMixer.js";
import { initStageOverview, paintStageOverview, forgetStageOverview } from "./stageOverview.js";
import { forgetCue, paintCue, readCueSections } from "./stageCue.js";
import { closeStageQueue, focusStagePlay, initStageUpNext } from "./stageUpNext.js";
import { LYRIC_LEAD_SEC } from "./stageModel.js";
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
import { dismissSingHandoff, singPlayheadAt, singQueueSettles } from "./stageSingQueue.js";
import { EMPTY_VALUE } from "./constants.js";
import { t, onLanguageChange } from "./i18n.js";
import { $ } from "./utils.js";

const OPEN_MODAL = 'dialog[open], [role="dialog"][aria-modal="true"]';

// Each lyric line Play along shows, by its distance from the line being sung.
const LYRIC_LINES = Object.freeze({ stageLyricPrev: -1, stageLyric: 0, stageLyricNext: 1, stageLyricNext2: 2 });

let frameId = 0;
let beatTable = [];
let playObserver = null;
// Last values written, so a frame that changes nothing writes nothing.
const shown = { playing: null, dotCount: null, dotOn: null, hasLyrics: null };

export function isStageMode() {
  return document.querySelector(".app")?.classList.contains("stage-mode") ?? false;
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
  for (const [id, step] of Object.entries(LYRIC_LINES)) {
    setLyric(shown, id, $(id), lineText(lines[index + step]));
  }
}

function isPlaying() {
  return Boolean(transport()?.isPlaying?.());
}

function paintFrame() {
  const time = transport()?.getCurrentTime?.() ?? 0;
  paintStageOverview(time, paintCue(time, beatTable));
  paintBeat(time);
  paintLyrics(time);
  paintStageMeters();
  if (isSingAlong()) paintSingFrame(time);
  singPlayheadAt(time);
  const playing = isPlaying();
  if (shown.playing !== playing) {
    shown.playing = playing;
    if (playing) singQueueSettles();
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
    readCueSections();
    tick();
    return;
  }
  stopLoop();
  readCueSections();
  paintFrame();
}

function paintSong() {
  const info = getPlayingTrackInfo();
  $("stageTitle").textContent = info?.displayTitle || EMPTY_VALUE;
  $("stageArtist").textContent = info?.artist ?? "";
  paintTempo();
  readCueSections();
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
  forgetCue();
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
 * The footer's play button and scrub fill carry every play, pause and seek, whoever caused it, and
 * its Loop button every loop change. Not its time text, which stays put for a seek inside the same second.
 */
function watchPlayback() {
  playObserver ??= new MutationObserver(syncLoop);
  const play = $("t-play");
  if (play) playObserver.observe(play, { attributes: true, attributeFilter: ["class"] });
  const loop = $("t-loop");
  if (loop) playObserver.observe(loop, { attributes: true, attributeFilter: ["class"] });
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
    focusStagePlay();
  } else {
    closeStageQueue({ refocus: false });
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
    if (!dismissSingHandoff() && !closeStageQueue()) setStageMode(false);
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

export function initStageMode() {
  $("stageModeBtn")?.addEventListener("click", onStageToggleClick);
  $("stageExitBtn")?.addEventListener("click", onStageExitClick);
  initStageMixer(isStageMode);
  initStageOverview(isStageMode);
  initStageUpNext();
  initSingAlong({ showing: isStageMode, redraw: redrawStage, leaveStage: onStageExitClick });
  window.addEventListener("keydown", onStageKeydown);
  document.addEventListener("trackopen", onSongChangeInStage);
  document.addEventListener("tracktags", onSongChangeInStage);
  document.addEventListener("tracklookup", onSongChangeInStage);
  document.addEventListener("tempochange", onTempoChange);
  document.addEventListener("lyricschange", onLyricsChange);
  document.addEventListener(DURATION_EVENT, onDurationKnown);
  onLanguageChange(onSongChangeInStage);
}
