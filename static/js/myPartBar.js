import { MIX_CHANGE_EVENT, setLaneMutes } from "./mixer.js";
import { mixerState } from "./state.js";
import { getLoadedStemNames } from "./player.js";
import { takeSoloActive } from "./takesMix.js";
import { STEM_DISPLAY, STEM_NAMES } from "./constants.js";
import { onLanguageChange, t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { $, storeGet, storeSet } from "./utils.js";
import { DEFAULT_PART, PRESET, PRESETS, activePreset, canUsePreset, mutesFor, partLanes } from "./myPart.js";
import { tagMyPartLanes } from "./myPartTags.js";

const PART_STORE_KEY = "stemdeck:my-part";
const STUDIO_HOST_ID = "myPartStudio";
const REASON_ID_PREFIX = "myPartReason";
const ON_CLASS = "is-on";
const CLASS = Object.freeze({
  BAR: "my-part",
  PICK: "my-part-pick",
  PICK_LABEL: "my-part-pick-label",
  NAME: "my-part-name",
  SELECT: "my-part-select",
  CHOICES: "my-part-choices",
  CHOICE: "my-part-choice",
  REASON: "my-part-reason",
});
const toSelector = (className) => `.${className}`;
const LABEL_KEY = "studio.myPart.label";
const PICK_KEY = "studio.myPart.pick";
const PICK_TITLE_KEY = "studio.myPart.pickTitle";
const MISSING_KEY = "studio.myPart.missing";
const PRESET_LABEL_KEYS = Object.freeze({
  [PRESET.FULL_BAND]: "studio.myPart.fullBand",
  [PRESET.WITHOUT_ME]: "studio.myPart.withoutMe",
  [PRESET.ONLY_ME]: "studio.myPart.onlyMe",
});
const CHEVRON_ICON = "down";
const USER_ICON = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

let part = DEFAULT_PART;
let barCount = 0;
const bars = new Set();

const stemNameKey = (name) => `stem.${name}`;
const partName = (name) => STEM_DISPLAY[name] || name;

function element(tag, className) {
  const el = document.createElement(tag);
  el.className = className;
  return el;
}

function translated(el, key) {
  el.dataset.i18n = key;
  el.textContent = t(key);
  return el;
}

function partOption(name) {
  const option = translated(document.createElement("option"), stemNameKey(name));
  option.value = name;
  return option;
}

function buildPick() {
  const pick = element("span", CLASS.PICK);
  pick.dataset.i18nTitle = PICK_TITLE_KEY;
  pick.title = t(PICK_TITLE_KEY);
  pick.innerHTML = USER_ICON;
  const picker = element("select", CLASS.SELECT);
  picker.dataset.i18nAriaLabel = LABEL_KEY;
  picker.setAttribute("aria-label", t(LABEL_KEY));
  picker.append(...STEM_NAMES.map(partOption));
  pick.append(translated(element("span", CLASS.PICK_LABEL), PICK_KEY), element("span", CLASS.NAME));
  pick.insertAdjacentHTML("beforeend", icon(CHEVRON_ICON));
  pick.append(picker);
  return pick;
}

function choiceButton(preset) {
  const button = translated(element("button", CLASS.CHOICE), PRESET_LABEL_KEYS[preset]);
  button.type = "button";
  button.dataset.preset = preset;
  return button;
}

function buildBar() {
  const bar = element("div", CLASS.BAR);
  bar.setAttribute("role", "group");
  bar.dataset.i18nAriaLabel = LABEL_KEY;
  bar.setAttribute("aria-label", t(LABEL_KEY));
  const choices = element("div", CLASS.CHOICES);
  choices.append(...PRESETS.map(choiceButton));
  const reason = element("p", CLASS.REASON);
  reason.id = `${REASON_ID_PREFIX}${++barCount}`;
  reason.hidden = true;
  bar.append(buildPick(), choices, reason);
  bar.addEventListener("change", onPartPicked);
  bar.addEventListener("click", onChoiceClick);
  return bar;
}

function missingReason(loaded) {
  if (!loaded.length || partLanes(part, loaded).length) return null;
  return t(MISSING_KEY, { part: partName(part) });
}

function paintChoice(button, on, loaded, reasonId) {
  const preset = button.dataset.preset;
  const usable = canUsePreset(preset, part, loaded);
  button.disabled = !usable;
  button.classList.toggle(ON_CLASS, preset === on);
  button.setAttribute("aria-pressed", String(preset === on));
  if (usable) button.removeAttribute("aria-describedby");
  else button.setAttribute("aria-describedby", reasonId);
}

function paintReason(reasonEl, text) {
  reasonEl.hidden = !text;
  reasonEl.textContent = text ?? "";
}

function paintBar(bar, loaded) {
  const name = bar.querySelector(toSelector(CLASS.NAME));
  name.dataset.i18n = stemNameKey(part);
  name.textContent = partName(part);
  bar.querySelector(toSelector(CLASS.SELECT)).value = part;
  const on = activePreset(part, loaded, mixerState, takeSoloActive());
  const reasonEl = bar.querySelector(toSelector(CLASS.REASON));
  paintReason(reasonEl, missingReason(loaded));
  bar.querySelectorAll(toSelector(CLASS.CHOICE)).forEach((button) => paintChoice(button, on, loaded, reasonEl.id));
}

function paintAll() {
  const loaded = getLoadedStemNames();
  bars.forEach((bar) => paintBar(bar, loaded));
  tagMyPartLanes(partLanes(part, loaded));
}

function onPartPicked(e) {
  if (!e.target.matches(toSelector(CLASS.SELECT))) return;
  part = e.target.value;
  storeSet(PART_STORE_KEY, part);
  paintAll();
}

function onChoiceClick(e) {
  const button = e.target.closest(toSelector(CLASS.CHOICE));
  if (!button || button.disabled) return;
  setLaneMutes(mutesFor(button.dataset.preset, part, getLoadedStemNames()));
}

export function mountMyPart(host) {
  if (!host) return null;
  const bar = buildBar();
  host.append(bar);
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
