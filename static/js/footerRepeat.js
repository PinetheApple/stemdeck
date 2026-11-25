// The footer's Repeat button: off, the queue, then the song, kept in this browser.

import { ON_CLASS } from "./footerClasses.js";
import { onLanguageChange, t } from "./i18n.js";
import { REPEAT, nextRepeat, readRepeat } from "./repeatModel.js";
import { $, storeGet, storeSet } from "./utils.js";

const REPEAT_STORE_KEY = "stemdeck.repeat";
const BUTTON_ID = "t-repeat";
const LABEL_KEYS = Object.freeze({
  [REPEAT.OFF]: "studio.footer.repeatOff",
  [REPEAT.QUEUE]: "studio.footer.repeatQueue",
  [REPEAT.SONG]: "studio.footer.repeatSong",
});

let mode = REPEAT.OFF;

export function repeatMode() {
  return mode;
}

function paintRepeatButton() {
  const button = $(BUTTON_ID);
  if (!button) return;
  const key = LABEL_KEYS[mode];
  const label = t(key);
  button.dataset.repeat = mode;
  button.dataset.i18nTitle = key;
  button.dataset.i18nAriaLabel = key;
  button.classList.toggle(ON_CLASS, mode !== REPEAT.OFF);
  button.title = label;
  button.setAttribute("aria-label", label);
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
  onLanguageChange(paintRepeatButton);
  paintRepeatButton();
  restoreRepeat().catch(console.error);
}
