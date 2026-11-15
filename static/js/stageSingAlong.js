// Sing along, Stage's second look: the lyrics fill the view word by word, and the
// voice can be taken out of the song without touching its saved mix.

import { getPlayingTrackInfo } from "./catalog.js";
import { MIX_CHANGE_EVENT, clearSilencedStems, isLaneSilenced, setSilencedStems } from "./mixer.js";
import { getLoadedStemNames } from "./player.js";
import { fillLine, getTimedLyricLines, hasUntimedLyrics, tagLang, vocalEnvelope } from "./lyrics.js";
import { wordFill } from "./lyricsLookup.js";
import { EXTRA_STEM_NAMES } from "./constants.js";
import { LYRIC_LEAD_SEC, readChoice, saveChoice } from "./stageModel.js";
import { lineText, setLyric } from "./stageLyricLine.js";
import { lyricWindow, silencedVocals, singStoreKey, vocalSplit, voiceOnFrom } from "./stageSingModel.js";
import { initSingQueue, singQueueLeaves, singQueueSettles } from "./stageSingQueue.js";
import { NO_LYRICS, initSingNoLyrics, paintSingNoLyrics } from "./stageSingNoLyrics.js";
import { t, onLanguageChange } from "./i18n.js";
import { $, fmtTickLabel, storeGet, storeSet } from "./utils.js";

const LOOK_STORE_KEY = "stemdeck.stage.look";
const LOOK_SING = "sing";
const SING_CLASS = "sing";
const NO_LYRICS_CLASS = "no-lyrics";
const INTRO_CLASS = "intro";
const WAITING_CLASS = "waiting";
const FILL_PROPERTY = "--fill";
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

const loadedStems = () => getLoadedStemNames();
const splitNow = () => vocalSplit(loadedStems(), EXTRA_STEM_NAMES);
const wantedSilence = () => silencedVocals({ split: splitNow(), voiceOn, backingOn }, loadedStems(), EXTRA_STEM_NAMES);

/** Keeps the chosen vocals quiet while Sing along is on screen, and gives them back after. */
function applySilence() {
  if (!singShown() || !getPlayingTrackInfo()) {
    if (silencing) clearSilencedStems();
    silencing = false;
    return;
  }
  silencing = true;
  setSilencedStems(wantedSilence());
}

/** A mix load (a new version of the song, say) drops what was silenced: put it back. */
function onMixChange() {
  if (silencing && wantedSilence().some((name) => !isLaneSilenced(name))) applySilence();
}

function paintVoice() {
  const split = splitNow();
  const backing = $("singBackingBtn");
  $("singVoiceBtn")?.setAttribute("aria-checked", String(voiceOn));
  if (!backing) return;
  backing.setAttribute("aria-checked", String(split && backingOn));
  backing.disabled = !split;
  backing.title = t(split ? "sing.backingTitle" : "sing.backingNoSplit");
}

async function readVoice() {
  const id = getPlayingTrackInfo()?.id;
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
  const id = getPlayingTrackInfo()?.id;
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
  saveChoice(LOOK_STORE_KEY, on ? LOOK_SING : null);
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

/** The line being sung as the Lyrics tab draws it: one span per timed word. */
function buildNowLine(el, lines, index) {
  const line = lines[index];
  const envelope = vocalEnvelope(getPlayingTrackInfo()?.id);
  nowLine = { lines, index, envelope, words: fillLine(el, line, lines[index + 1]?.time ?? null) };
  el.removeAttribute("lang");
  tagLang(el, line.text);
}

function paintNowLine(lines, index, time) {
  const el = $("singLineNow");
  if (!el) return;
  const stale = !nowLine || nowLine.lines !== lines || nowLine.index !== index;
  if (stale || nowLine.envelope !== vocalEnvelope(getPlayingTrackInfo()?.id)) buildNowLine(el, lines, index);
  for (const word of nowLine.words) {
    const { sung, singing, fill } = wordFill(word, time);
    word.el.classList.toggle("sung", sung);
    word.el.classList.toggle("singing", singing);
    if (singing) word.el.style.setProperty(FILL_PROPERTY, `${fill}%`);
  }
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
    setLyric(shownLines, id, $(id), lineText(shown ? lines[view.now + step] : null));
  }
}

/** One frame of Sing along at `time`: the lines around the one being sung, its words filled so far. */
export function paintSingFrame(time) {
  const lines = getTimedLyricLines();
  const view = lyricWindow(lines, time + LYRIC_LEAD_SEC);
  $("stageView")?.classList.toggle(NO_LYRICS_CLASS, !view);
  $("singLyrics").hidden = !view;
  paintSingNoLyrics(view ? null : hasUntimedLyrics() ? NO_LYRICS.UNTIMED : NO_LYRICS.NONE);
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

/** `showing()`: whether Stage is on screen; `redraw()` paints it again; `leaveStage()` closes it. */
export function initSingAlong({ showing, redraw, leaveStage }) {
  isShowing = showing;
  repaint = redraw;
  sing = readChoice(LOOK_STORE_KEY) === LOOK_SING;
  paintLook();
  paintVoice();
  $("stageLook")?.addEventListener("click", onLookClick);
  $("stageLook")?.addEventListener("keydown", onLookKeydown);
  $("singVoiceBtn")?.addEventListener("click", onVoiceClick);
  $("singBackingBtn")?.addEventListener("click", onBackingClick);
  document.addEventListener("trackopen", onTrackOpen);
  document.addEventListener("playbackready", onPlaybackReady);
  document.addEventListener(MIX_CHANGE_EVENT, onMixChange);
  onLanguageChange(paintVoice);
  initSingQueue({ active: singShown });
  initSingNoLyrics({ leaveStage });
}
