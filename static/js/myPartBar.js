// The My part bar: pick the stem you play, then hear the full band, the band without you, or only you.
// The studio's bar mounts itself; Stage's Mix panel mounts another with mountMyPart. All bars share one part.

import { MIX_CHANGE_EVENT, setLaneMutes } from "./mixer.js";
import { mixerState } from "./state.js";
import { getLoadedStemNames } from "./player.js";
import { STEM_DISPLAY, STEM_NAMES } from "./constants.js";
import { onLanguageChange, t } from "./i18n.js";
import { $, storeGet, storeSet } from "./utils.js";
import { DEFAULT_PART, PRESET, PRESETS, activePreset, canUsePreset, mutesFor, partLanes } from "./myPart.js";
import { tagMyPartLanes } from "./myPartTags.js";

const PART_STORE_KEY = "stemdeck:my-part";
const STUDIO_HOST_ID = "myPartStudio";
const ON_CLASS = "is-on";
const LABEL_KEY = "studio.myPart.label";
const PICK_TITLE_KEY = "studio.myPart.pickTitle";
const MISSING_KEY = "studio.myPart.missing";
const PRESET_LABEL_KEYS = Object.freeze({
  [PRESET.FULL_BAND]: "studio.myPart.fullBand",
  [PRESET.WITHOUT_ME]: "studio.myPart.withoutMe",
  [PRESET.ONLY_ME]: "studio.myPart.onlyMe",
});
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const USER_ICON = `<svg class="my-part-icon" ${ICON_ATTRS}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const CHEVRON_ICON = `<svg class="my-part-chevron" ${ICON_ATTRS}><path d="m6 9 6 6 6-6"/></svg>`;

let part = DEFAULT_PART;
const bars = new Set();

const stemNameKey = (name) => `stem.${name}`;
const partName = (name) => STEM_DISPLAY[name] || name;

function translated(el, key) {
  el.dataset.i18n = key;
  el.textContent = t(key);
  return el;
}

function element(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function partOption(name) {
  const option = translated(document.createElement("option"), stemNameKey(name));
  option.value = name;
  return option;
}

function buildPick() {
  const pick = element("span", "my-part-pick");
  pick.dataset.i18nTitle = PICK_TITLE_KEY;
  pick.title = t(PICK_TITLE_KEY);
  pick.innerHTML = USER_ICON;
  const select = element("select", "my-part-select");
  select.dataset.i18nAriaLabel = LABEL_KEY;
  select.setAttribute("aria-label", t(LABEL_KEY));
  select.append(...STEM_NAMES.map(partOption));
  pick.append(
    translated(element("span", "my-part-label"), "studio.myPart.pick"),
    element("span", "my-part-name"),
  );
  pick.insertAdjacentHTML("beforeend", CHEVRON_ICON);
  pick.append(select);
  return pick;
}

function choiceButton(preset) {
  const button = translated(element("button", "my-part-choice"), PRESET_LABEL_KEYS[preset]);
  button.type = "button";
  button.dataset.preset = preset;
  return button;
}

function buildBar() {
  const bar = element("div", "my-part");
  bar.setAttribute("role", "group");
  bar.dataset.i18nAriaLabel = LABEL_KEY;
  bar.setAttribute("aria-label", t(LABEL_KEY));
  const choices = element("div", "my-part-choices");
  choices.append(...PRESETS.map(choiceButton));
  bar.append(buildPick(), choices);
  bar.addEventListener("change", onPartPicked);
  bar.addEventListener("click", onChoiceClick);
  return bar;
}

function setTitle(el, title) {
  if (title) el.title = title;
  else el.removeAttribute("title");
}

function missingReason(loaded) {
  if (!loaded.length || partLanes(part, loaded).length) return null;
  return t(MISSING_KEY, { part: partName(part) });
}

function paintChoice(button, on, loaded, reason) {
  const preset = button.dataset.preset;
  const usable = canUsePreset(preset, part, loaded);
  button.disabled = !usable;
  button.classList.toggle(ON_CLASS, preset === on);
  button.setAttribute("aria-pressed", String(preset === on));
  setTitle(button, usable ? null : reason);
}

function paintBar(bar, loaded) {
  const name = bar.querySelector(".my-part-name");
  name.dataset.i18n = stemNameKey(part);
  name.textContent = partName(part);
  bar.querySelector(".my-part-select").value = part;
  const on = activePreset(part, loaded, mixerState);
  const reason = missingReason(loaded);
  bar.querySelectorAll(".my-part-choice").forEach((button) => paintChoice(button, on, loaded, reason));
  setTitle(bar.querySelector(".my-part-choices"), reason);
}

function paintAll() {
  const loaded = getLoadedStemNames();
  bars.forEach((bar) => paintBar(bar, loaded));
  tagMyPartLanes(partLanes(part, loaded));
}

function onPartPicked(e) {
  if (!e.target.matches(".my-part-select")) return;
  part = e.target.value;
  storeSet(PART_STORE_KEY, part);
  paintAll();
}

function onChoiceClick(e) {
  const button = e.target.closest(".my-part-choice");
  if (!button || button.disabled) return;
  setLaneMutes(mutesFor(button.dataset.preset, part, getLoadedStemNames()));
}

/** Puts a My part bar into `host`, before `before` (or last), and keeps it in step. */
export function mountMyPart(host, before = null) {
  if (!host) return null;
  const bar = buildBar();
  host.insertBefore(bar, before);
  bars.add(bar);
  paintBar(bar, getLoadedStemNames());
  return bar;
}

async function initMyPart() {
  document.addEventListener(MIX_CHANGE_EVENT, paintAll);
  onLanguageChange(paintAll);
  mountMyPart($(STUDIO_HOST_ID));
  const stored = await storeGet(PART_STORE_KEY, DEFAULT_PART);
  if (STEM_NAMES.includes(stored)) part = stored;
  paintAll();
}

// player.js and this module import each other through stageMixer.js, so nothing here may run before the graph has.
document.addEventListener("DOMContentLoaded", initMyPart);
