// The footer's Repeat button: off, the queue, then the song, kept in this browser.

import { ON_CLASS } from "./footerClasses.js";
import { onLanguageChange, t } from "./i18n.js";
import { REPEAT, nextRepeat, readRepeat } from "./repeatModel.js";
import { $, storeGet, storeSet } from "./utils.js";

const REPEAT_STORE_KEY = "stemdeck.repeat";
const BUTTON_ID = "t-repeat";
const CAPTION_ID = "t-repeat-caption";
const LABEL_KEYS = Object.freeze({
  [REPEAT.OFF]: "studio.footer.repeatOff",
  [REPEAT.QUEUE]: "studio.footer.repeatQueue",
  [REPEAT.SONG]: "studio.footer.repeatSong",
});
const CAPTION_KEYS = Object.freeze({
  [REPEAT.OFF]: "studio.footer.repeatCaptionOff",
  [REPEAT.QUEUE]: "studio.footer.repeatCaptionQueue",
  [REPEAT.SONG]: "studio.footer.repeatCaptionSong",
});

let mode = REPEAT.OFF;

export function repeatMode() {
  return mode;
}

/** The i18n keys for a Repeat state: its full name, and the short caption under the icon. */
export function repeatText(state) {
  return { label: LABEL_KEYS[state], caption: CAPTION_KEYS[state] };
}

/** Moves to the next state and keeps it; returns the new state. */
export function cycleRepeat() {
  mode = nextRepeat(mode);
  storeSet(REPEAT_STORE_KEY, mode);
  return mode;
}

/** Reads the kept state back; returns it. */
export async function restoreRepeat() {
  mode = readRepeat(await storeGet(REPEAT_STORE_KEY, REPEAT.OFF));
  return mode;
}

function paintRepeatButton() {
  const button = $(BUTTON_ID);
  if (!button) return;
  const { label: key, caption } = repeatText(mode);
  const label = t(key);
  button.dataset.repeat = mode;
  button.dataset.i18nTitle = key;
  button.dataset.i18nAriaLabel = key;
  button.closest(".ft-seg")?.classList.toggle(ON_CLASS, mode !== REPEAT.OFF);
  button.title = label;
  button.setAttribute("aria-label", label);
  const captionEl = $(CAPTION_ID);
  captionEl.dataset.i18n = caption;
  captionEl.textContent = t(caption);
}

function onRepeatClick() {
  cycleRepeat();
  paintRepeatButton();
}

export function initRepeatButton() {
  $(BUTTON_ID)?.addEventListener("click", onRepeatClick);
  onLanguageChange(paintRepeatButton);
  paintRepeatButton();
  restoreRepeat().then(paintRepeatButton).catch(console.error);
}
