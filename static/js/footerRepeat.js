// The footer's Repeat button: off, the queue, then the song, kept in this browser.

import { ON_CLASS } from "./footerClasses.js";
import { onLanguageChange, t } from "./i18n.js";
import { contextSongsAhead, hasPlayList, playListAgain } from "./playContext.js";
import { LIST_AT, REPEAT, REPEAT_START, nextRepeat, readRepeat, repeatAtEnd } from "./repeatModel.js";
import { restartSong, togglePlayPause, transport } from "./transport.js";
import { replayUpNextRun, setSongEndRepeat, upNextRunLength } from "./upNext.js";
import { $, storeGet, storeSet } from "./utils.js";

export const REPEAT_STORE_KEY = "stemdeck.repeat";
const BUTTON_ID = "t-repeat";
const LABEL_KEYS = Object.freeze({
  [REPEAT.OFF]: "studio.footer.repeatOff",
  [REPEAT.QUEUE]: "studio.footer.repeatQueue",
  [REPEAT.SONG]: "studio.footer.repeatSong",
});

let mode = REPEAT.OFF;

function paintRepeatButton() {
  const button = $(BUTTON_ID);
  if (!button) return;
  const label = t(LABEL_KEYS[mode]);
  button.dataset.repeat = mode;
  button.classList.toggle(ON_CLASS, mode !== REPEAT.OFF);
  button.title = label;
  button.setAttribute("aria-label", label);
}

function playSongAgain() {
  restartSong();
  if (!transport()?.isPlaying()) togglePlayPause();
}

function listPosition() {
  if (!hasPlayList()) return LIST_AT.NONE;
  return contextSongsAhead().length ? LIST_AT.AHEAD : LIST_AT.END;
}

const STARTS = Object.freeze({
  [REPEAT_START.SONG]: playSongAgain,
  [REPEAT_START.RUN]: replayUpNextRun,
  [REPEAT_START.LIST]: playListAgain,
});

function repeatOnSongEnd(queued) {
  const start = repeatAtEnd({ mode, queued, runLength: upNextRunLength(), list: listPosition() });
  return start ? STARTS[start] : null;
}

function onRepeatClick() {
  mode = nextRepeat(mode);
  storeSet(REPEAT_STORE_KEY, mode);
  paintRepeatButton();
}

async function restoreRepeat() {
  mode = readRepeat(await storeGet(REPEAT_STORE_KEY, REPEAT.OFF));
  paintRepeatButton();
}

export function initRepeatButton() {
  $(BUTTON_ID)?.addEventListener("click", onRepeatClick);
  setSongEndRepeat(repeatOnSongEnd);
  onLanguageChange(paintRepeatButton);
  paintRepeatButton();
  restoreRepeat().catch(console.error);
}
