// A stem lane's header: name (mutes), M, S, fader and level on the first row; EQ, Key
// and Stem on the second, or in the lane's ⋯ menu when the lane is too short for two rows.

import { STEM_COLORS, STEM_DISPLAY, LANE_VOLUME_MAX } from "./constants.js";
import { mixerState } from "./state.js";
import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import {
  refreshLaneKeyVisual,
  setLanePitch,
  setLaneVolume,
  toggleStemMute,
  toggleStemSolo,
  updateLaneKnobVisual,
} from "./mixer.js";
import { openLaneMenu } from "./laneMenu.js";

export const FADER_STEP = 0.01;
export const FADER_UNITY = 1;
export const WHEEL_STEP = 0.04;
export const WHEEL_STEP_COARSE = 0.2;
export const PITCH_STEP = 1;
const FALLBACK_COLOR = "#a0a0a0";
const LOCKED_LANE = "drums";
// A real minus sign: a hyphen beside a plus sign reads as a dash.
const MINUS_SIGN = "\u2212";
const DOWNLOAD_ICON = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
  + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/>'
  + '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>';

const displayName = (stemName) => STEM_DISPLAY[stemName] || stemName;

function el(tag, className, text = "") {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className, text = "") {
  const btn = el("button", className, text);
  btn.type = "button";
  return btn;
}

function nameButton(stemName) {
  const btn = button("mx-name lane-name", displayName(stemName));
  btn.title = t("studio.lane.nameTitle", { name: displayName(stemName) });
  btn.addEventListener("click", function onLaneNameClick() { toggleStemMute(stemName); });
  return btn;
}

function muteButton(stemName) {
  const muted = mixerState[stemName]?.muted ?? false;
  const btn = button(`lane-icon-toggle mx-btn mute${muted ? "" : " active"}`, "M");
  btn.setAttribute("aria-label", t("aria.mute", { name: displayName(stemName) }));
  btn.setAttribute("aria-pressed", String(muted));
  btn.addEventListener("click", function onLaneMuteClick() { toggleStemMute(stemName); });
  return btn;
}

function soloButton(stemName) {
  const soloed = mixerState[stemName]?.soloed ?? false;
  const btn = button(`solo ms-btn mx-btn${soloed ? " active" : ""}`, "S");
  btn.setAttribute("aria-label", t("aria.solo", { name: displayName(stemName) }));
  btn.setAttribute("aria-pressed", String(soloed));
  btn.addEventListener("click", function onLaneSoloClick() { toggleStemSolo(stemName); });
  return btn;
}

function faderInput(stemName, color) {
  const input = el("input", "mx-fader-input");
  input.type = "range";
  input.min = "0";
  input.max = String(LANE_VOLUME_MAX);
  input.step = String(FADER_STEP);
  input.value = String(FADER_UNITY);
  input.title = t("studio.lane.faderTitle");
  input.style.setProperty("--fader-color", color);
  input.setAttribute("aria-label", t("aria.volume", { name: displayName(stemName) }));
  input.addEventListener("input", function onLaneFaderInput() { setLaneVolume(stemName, parseFloat(input.value)); });
  return input;
}

function fader(stemName, color) {
  const wrap = el("div", "lane-knob mx-fader");
  wrap.dataset.stem = stemName;
  wrap.append(faderInput(stemName, color));
  wrap.addEventListener("dblclick", function onLaneFaderReset() { setLaneVolume(stemName, FADER_UNITY); });
  wrap.addEventListener("wheel", function onLaneFaderWheel(e) {
    e.preventDefault();
    const step = e.shiftKey ? WHEEL_STEP_COARSE : WHEEL_STEP;
    setLaneVolume(stemName, (mixerState[stemName]?.volume ?? FADER_UNITY) - Math.sign(e.deltaY) * step);
  }, { passive: false });
  return wrap;
}

function moreButton(stemName) {
  const label = t("studio.lane.more", { name: displayName(stemName) });
  const btn = button("lane-more");
  btn.innerHTML = icon("more");
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", function onLaneMoreClick() { openLaneMenu(stemName, btn); });
  return btn;
}

function keyStep(stemName, direction) {
  const up = direction > 0;
  const btn = button(`lane-key-step ${up ? "up" : "down"}`, up ? "+" : MINUS_SIGN);
  btn.setAttribute("aria-label", t(up ? "aria.laneKeyUp" : "aria.laneKeyDown", { name: displayName(stemName) }));
  if (stemName === LOCKED_LANE) btn.disabled = true;
  else btn.addEventListener("click", function onLaneKeyStep() {
    setLanePitch(stemName, (mixerState[stemName]?.pitch ?? 0) + direction);
  });
  return btn;
}

/** Key, minus, the lane's key in semitones, plus. Drums keep it, disabled, saying why. */
function keyStepper(stemName) {
  const wrap = el("div", "lane-key");
  wrap.dataset.stem = stemName;
  if (stemName === LOCKED_LANE) {
    wrap.classList.add("locked");
    wrap.title = t("mixer.key.drumsLocked");
  }
  wrap.append(
    el("span", "lane-key-label", t("studio.lane.key")),
    keyStep(stemName, -PITCH_STEP),
    el("span", "lane-key-value", "0"),
    keyStep(stemName, PITCH_STEP),
  );
  return wrap;
}

function stemDownload(stemName, url) {
  const link = el("a", "lane-dl");
  link.href = url;
  link.download = `${stemName}.wav`;
  link.title = t("aria.download", { name: displayName(stemName) });
  link.innerHTML = DOWNLOAD_ICON;
  link.append(el("span", "lane-x-label", t("studio.lane.stem")));
  return link;
}

/** The EQ mark lane C builds, labelled as the second row's EQ button. */
function eqButton(eqMark) {
  eqMark.classList.add("lane-eq");
  eqMark.append(el("span", "lane-x-label", t("studio.lane.eq")));
  return eqMark;
}

function meter(stemName) {
  const vu = el("div", "lane-vu mx-meter");
  vu.dataset.stem = stemName;
  vu.append(el("div", "lane-vu-bar mx-meter-fill"));
  return vu;
}

/** The header row for `stem` ({name, url}); `eqMark` is the lane's EQ button. */
export function buildLaneHeader(stem, eqMark) {
  const color = STEM_COLORS[stem.name] || FALLBACK_COLOR;
  const state = mixerState[stem.name];
  const row = el("div", "lane-header mx-row lane-head");
  row.dataset.stem = stem.name;
  row.style.setProperty("--lane-color", color);
  const main = el("div", "lane-main");
  const knob = fader(stem.name, color);
  main.append(
    nameButton(stem.name), muteButton(stem.name), soloButton(stem.name), knob,
    el("span", "mx-val"), moreButton(stem.name),
  );
  const extra = el("div", "lane-x");
  extra.append(eqButton(eqMark), keyStepper(stem.name), stemDownload(stem.name, stem.url));
  const body = el("div", "lane-body");
  body.append(main, extra);
  row.append(el("div", "lane-stripe"), body, meter(stem.name));
  row.classList.toggle("muted", state?.muted ?? false);
  if (state) updateLaneKnobVisual(knob, state.volume);
  refreshLaneKeyVisual(stem.name);
  return row;
}
