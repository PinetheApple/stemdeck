// Sing along, Stage's second look: the lyrics fill the view word by word, and the
// voice can be taken out of the song without touching its saved mix.

import { getCurrentTrackInfo } from "./catalog.js";
import { clearSilencedStems, setSilencedStems } from "./mixer.js";
import { getLoadedStemNames } from "./player.js";
import { getTimedLyricLines, tagLang, vocalEnvelope } from "./lyrics.js";
import { wordTimings } from "./lyricsLookup.js";
import { EXTRA_STEM_NAMES } from "./constants.js";
import { GAP_LINE, LYRIC_LEAD_SEC } from "./stageModel.js";
import {
  WORD_STATE,
  lyricWindow,
  silencedVocals,
  singStoreKey,
  vocalSplit,
  voiceOnFrom,
  wordProgress,
} from "./stageSingModel.js";
import { initSingQueue, singQueueLeaves, singQueueSettles } from "./stageSingQueue.js";
import { initSingNoLyrics, paintSingNoLyrics } from "./stageSingNoLyrics.js";
import { t, onLanguageChange } from "./i18n.js";
import { $, fmtTickLabel, storeGet, storeSet } from "./utils.js";

const LOOK_STORE_KEY = "stemdeck.stage.look";
const LOOK_SING = "sing";
const SING_CLASS = "sing";
const NO_LYRICS_CLASS = "no-lyrics";
const INTRO_CLASS = "intro";
const WAITING_CLASS = "waiting";
const FILL_PROPERTY = "--fill";
const WORD_CLASS = "sing-word";
const LOOK_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const SIDE_LINES = Object.freeze({ singLinePast: -1, singLineNear: 1, singLineFar: 2 });

let sing = false;
let isShowing = () => false;
let repaint = () => {};
let silencing = false;
let voiceOn = false;
let backingOn = true;
let voiceRead = 0;
let shownLines = {};
let nowLine = null;

export const isSingAlong = () => sing;
const singShown = () => sing && isShowing();

function readLook() {
  try {
    return localStorage.getItem(LOOK_STORE_KEY) === LOOK_SING;
  } catch (e) {
    console.warn("[stage] could not read the chosen look:", e);
    return false;
  }
}

function saveLook(on) {
  try {
    if (on) localStorage.setItem(LOOK_STORE_KEY, LOOK_SING);
    else localStorage.removeItem(LOOK_STORE_KEY);
  } catch (e) {
    console.warn("[stage] could not save the chosen look:", e);
  }
}

const splitNow = () => vocalSplit(getLoadedStemNames(), EXTRA_STEM_NAMES);

/** Keeps the chosen vocals quiet while Sing along is on screen, and gives them back after. */
function applySilence() {
  if (!singShown() || !getCurrentTrackInfo()) {
    if (silencing) clearSilencedStems();
    silencing = false;
    return;
  }
  silencing = true;
  setSilencedStems(silencedVocals({ split: splitNow(), voiceOn, backingOn }, EXTRA_STEM_NAMES));
}

function paintSwitch(button, on) {
  button?.setAttribute("aria-checked", String(on));
}

function paintVoice() {
  const split = splitNow();
  const backing = $("singBackingBtn");
  paintSwitch($("singVoiceBtn"), voiceOn);
  paintSwitch(backing, split && backingOn);
  if (!backing) return;
  backing.disabled = !split;
  backing.title = t(split ? "sing.backingTitle" : "sing.backingNoSplit");
}

async function readVoice() {
  const id = getCurrentTrackInfo()?.id;
  const mine = ++voiceRead;
  voiceOn = false;
  backingOn = true;
  paintVoice();
  applySilence();
  if (!id) return;
  const stored = await storeGet(singStoreKey(id), null);
  if (mine !== voiceRead) return;
  voiceOn = voiceOnFrom(stored);
  paintVoice();
  applySilence();
}

function onVoiceClick() {
  const id = getCurrentTrackInfo()?.id;
  if (!id) return;
  voiceOn = !voiceOn;
  storeSet(singStoreKey(id), { voice: voiceOn });
  paintVoice();
  applySilence();
}

function onBackingClick() {
  backingOn = !backingOn;
  paintVoice();
  applySilence();
}

function paintLook() {
  $("stageView")?.classList.toggle(SING_CLASS, sing);
  for (const [id, on] of [["stageLookPlay", !sing], ["stageLookSing", sing]]) {
    const radio = $(id);
    radio?.setAttribute("aria-checked", String(on));
    if (radio) radio.tabIndex = on ? 0 : -1;
  }
}

function setLook(on) {
  if (on === sing) return;
  sing = on;
  saveLook(on);
  if (!on) singQueueLeaves();
  paintLook();
  forgetSingPainted();
  applySilence();
  if (isShowing()) repaint();
}

function onLookClick(e) {
  const radio = e.target.closest("[role='radio']");
  if (radio) setLook(radio.id === "stageLookSing");
}

function onLookKeydown(e) {
  if (!LOOK_KEYS.has(e.key)) return;
  e.preventDefault();
  setLook(!sing);
  $(sing ? "stageLookSing" : "stageLookPlay")?.focus();
}

function setLine(el, line) {
  const text = line ? line.text || GAP_LINE : "";
  if (!el || shownLines[el.id] === text) return;
  shownLines[el.id] = text;
  el.textContent = text;
  el.removeAttribute("lang");
  tagLang(el, text);
}

function buildNowLine(el, lines, index) {
  const line = lines[index];
  const envelope = vocalEnvelope(getCurrentTrackInfo()?.id);
  const timed = wordTimings(line, lines[index + 1]?.time ?? null, envelope);
  nowLine = { lines, index, envelope, words: timed };
  el.replaceChildren(...timed.map((word) => wordSpan(word.text)));
  if (!timed.length) el.textContent = line.text || GAP_LINE;
  el.removeAttribute("lang");
  tagLang(el, line.text);
}

function wordSpan(text) {
  const span = document.createElement("span");
  span.className = WORD_CLASS;
  span.textContent = text;
  return span;
}

function paintNowLine(lines, index, time) {
  const el = $("singLineNow");
  if (!el) return;
  const stale = !nowLine || nowLine.lines !== lines || nowLine.index !== index;
  if (stale || nowLine.envelope !== vocalEnvelope(getCurrentTrackInfo()?.id)) buildNowLine(el, lines, index);
  const spans = el.children;
  wordProgress(nowLine.words, time).forEach(({ state, fill }, i) => {
    const span = spans[i];
    if (!span) return;
    span.classList.toggle(WORD_STATE.SUNG, state === WORD_STATE.SUNG);
    span.classList.toggle(WORD_STATE.SINGING, state === WORD_STATE.SINGING);
    if (state === WORD_STATE.SINGING) span.style.setProperty(FILL_PROPERTY, `${fill}%`);
  });
}

function paintIntro(intro) {
  const box = $("singIntro");
  if (box) box.hidden = intro == null;
  $("stageView")?.classList.toggle(INTRO_CLASS, intro != null);
  $("singLineNow")?.classList.toggle(WAITING_CLASS, intro != null);
  if (intro != null) $("singIntroTime").textContent = fmtTickLabel(Math.ceil(intro));
}

function paintLyricWindow(lines, view) {
  paintIntro(view.intro);
  for (const [id, step] of Object.entries(SIDE_LINES)) {
    const shown = view.intro == null || step > 0;
    setLine($(id), shown ? lines[view.now + step] : null);
  }
}

/** One frame of Sing along at `time`: the lines around the one being sung, its words filled so far. */
export function paintSingFrame(time) {
  const lines = getTimedLyricLines();
  const view = lyricWindow(lines, time + LYRIC_LEAD_SEC);
  $("stageView")?.classList.toggle(NO_LYRICS_CLASS, !view);
  $("singLyrics").hidden = !view;
  paintSingNoLyrics(!view);
  if (!view) {
    paintIntro(null);
    return;
  }
  paintLyricWindow(lines, view);
  paintNowLine(lines, view.now, time + LYRIC_LEAD_SEC);
}

export function forgetSingPainted() {
  shownLines = {};
  nowLine = null;
}

/** Stage opened or closed. */
export function singStageShown(on) {
  if (!on) singQueueLeaves();
  forgetSingPainted();
  applySilence();
}

/** A new song in Stage, or the same one renamed or relabelled. */
export function singSongChange() {
  forgetSingPainted();
  paintVoice();
}

function onTrackOpen() {
  singQueueSettles();
  readVoice();
}

/** The mix reloads with each engine, and a reload drops what was silenced. */
function onPlaybackReady() {
  paintVoice();
  applySilence();
}

/** `showing()` says whether Stage is on screen; `redraw()` paints its frame again. */
export function initSingAlong({ showing, redraw, leaveStage }) {
  isShowing = showing;
  repaint = redraw;
  sing = readLook();
  paintLook();
  paintVoice();
  $("stageLook")?.addEventListener("click", onLookClick);
  $("stageLook")?.addEventListener("keydown", onLookKeydown);
  $("singVoiceBtn")?.addEventListener("click", onVoiceClick);
  $("singBackingBtn")?.addEventListener("click", onBackingClick);
  document.addEventListener("trackopen", onTrackOpen);
  document.addEventListener("playbackready", onPlaybackReady);
  onLanguageChange(paintVoice);
  initSingQueue({ active: singShown });
  initSingNoLyrics({ leaveStage });
}
