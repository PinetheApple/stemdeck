// Stage mode's Mix panel: one row per loaded stem, reading and driving the studio's own mix.

import { mixerState } from "./state.js";
import {
  MIX_CHANGE_EVENT,
  isLaneSilenced,
  laneGainDbText,
  loadedLaneNames,
  setLaneVolume,
  toggleStemMute,
  toggleStemSolo,
} from "./mixer.js";
import { getLoadedStemNames } from "./player.js";
import { LANE_VOLUME_MAX, STEM_COLORS, STEM_DISPLAY } from "./constants.js";
import { PERCENT, readChoice, saveChoice, stripStems } from "./stageModel.js";
import { t } from "./i18n.js";
import { $ } from "./utils.js";

const HIDDEN_STORE_KEY = "stemdeck.stage.mixHidden";
const HIDDEN_STORED = "1";
const HIDDEN_CLASS = "mixer-hidden";
const FADER_STEP = "0.01";
const MUTE_LETTER = "M";
const SOLO_LETTER = "S";
const VU_SCALE = "--vu-scale";
const studioMeter = (name) => document.querySelector(`.stem-list [data-stem="${name}"] .mini-meter`);

let shownStems = "";
let isShowing = () => false;

const stemLabel = (name) => STEM_DISPLAY[name] || name;

const readMixHidden = () => readChoice(HIDDEN_STORE_KEY) === HIDDEN_STORED;
const saveMixHidden = (hidden) => saveChoice(HIDDEN_STORE_KEY, hidden ? HIDDEN_STORED : null);

function showMixHidden(hidden) {
  $("stageView")?.classList.toggle(HIDDEN_CLASS, hidden);
  $("stageMixBtn")?.setAttribute("aria-pressed", String(!hidden));
}

function onMixToggleClick() {
  const hidden = !$("stageView")?.classList.contains(HIDDEN_CLASS);
  showMixHidden(hidden);
  saveMixHidden(hidden);
}

function stripButton(className, letter, labelKey, name) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `stage-ms ${className}`;
  button.textContent = letter;
  button.setAttribute("aria-label", t(labelKey, { name: stemLabel(name) }));
  return button;
}

function stripFader(name) {
  const fader = document.createElement("input");
  fader.type = "range";
  fader.className = "stage-strip-fader";
  fader.min = "0";
  fader.max = String(LANE_VOLUME_MAX);
  fader.step = FADER_STEP;
  fader.setAttribute("aria-label", t("aria.volume", { name: stemLabel(name) }));
  // WebKit's range-track pseudo-element does not see custom properties set on ancestors.
  fader.style.setProperty("--stem-color", STEM_COLORS[name] ?? "");
  return fader;
}

function makeStrip(name) {
  const strip = document.createElement("div");
  strip.className = "stage-strip";
  strip.dataset.stem = name;
  strip.style.setProperty("--stem-color", STEM_COLORS[name] ?? "");
  const label = document.createElement("span");
  label.className = "stage-strip-name";
  label.textContent = stemLabel(name);
  const value = document.createElement("span");
  value.className = "stage-strip-value num";
  const meter = document.createElement("span");
  meter.className = "stage-strip-meter";
  meter.setAttribute("aria-hidden", "true");
  strip.append(
    label,
    stripButton("mute", MUTE_LETTER, "aria.mute", name),
    stripButton("solo", SOLO_LETTER, "aria.solo", name),
    stripFader(name),
    value,
    meter,
  );
  return strip;
}

function paintStrip(strip) {
  const name = strip.dataset.stem;
  const state = mixerState[name];
  if (!state) return;
  const fader = strip.querySelector(".stage-strip-fader");
  fader.value = String(state.volume);
  fader.style.setProperty("--pos", `${(state.volume / LANE_VOLUME_MAX) * PERCENT}%`);
  const dbText = laneGainDbText(state.volume);
  fader.setAttribute("aria-valuetext", dbText);
  strip.querySelector(".stage-strip-value").textContent = dbText;
  strip.querySelector(".mute").setAttribute("aria-pressed", String(state.muted));
  strip.querySelector(".solo").setAttribute("aria-pressed", String(state.soloed));
  strip.classList.toggle("silent", isLaneSilenced(name));
}

function rebuildStrips(stems) {
  const list = $("stageMixerStrips");
  if (!list) return;
  shownStems = stems.join();
  list.replaceChildren(...stems.map(makeStrip));
}

/** Rebuilds the strips when the loaded stems changed, then paints every strip from the mix. */
export function paintStageMixer() {
  const stems = stripStems(loadedLaneNames(), getLoadedStemNames());
  if (stems.join() !== shownStems) rebuildStrips(stems);
  $("stageMixerStrips")?.querySelectorAll(".stage-strip").forEach(paintStrip);
}

/** Each row's meter shows its studio lane's level, which player.js keeps as `--vu-scale`. */
export function paintStageMeters() {
  for (const meter of $("stageMixerStrips")?.querySelectorAll(".stage-strip-meter") ?? []) {
    const level = studioMeter(stemOf(meter))?.style.getPropertyValue(VU_SCALE) ?? "";
    if (meter.style.getPropertyValue(VU_SCALE) !== level) meter.style.setProperty(VU_SCALE, level);
  }
}

/** Entering Stage, a new song or a new language: the next paint builds the strips anew. */
export function forgetStageMixer() {
  shownStems = "";
}

const stemOf = (el) => el.closest(".stage-strip")?.dataset.stem;

function onStripClick(e) {
  const button = e.target.closest(".stage-ms");
  const name = button && stemOf(button);
  if (!name) return;
  if (button.classList.contains("mute")) toggleStemMute(name);
  else toggleStemSolo(name);
}

function onStripInput(e) {
  const name = e.target.matches(".stage-strip-fader") && stemOf(e.target);
  if (name) setLaneVolume(name, parseFloat(e.target.value));
}

function onMixChange() {
  if (isShowing()) paintStageMixer();
}

/** `showing()` says whether Stage is on screen, so a mix change off stage costs nothing. */
export function initStageMixer(showing) {
  isShowing = showing;
  showMixHidden(readMixHidden());
  $("stageMixBtn")?.addEventListener("click", onMixToggleClick);
  $("stageMixerStrips")?.addEventListener("click", onStripClick);
  $("stageMixerStrips")?.addEventListener("input", onStripInput);
  document.addEventListener(MIX_CHANGE_EVENT, onMixChange);
}
