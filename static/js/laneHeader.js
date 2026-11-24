// A stem lane's header: name (mutes), M, S, fader and level on the first row; EQ, Key
// and Stem on the second, or in the lane's ⋯ menu when the lane is too short for two rows.

import {
  STEM_COLORS,
  LANE_VOLUME_MAX,
  FADER_STEP,
  FADER_UNITY,
  WHEEL_STEP,
  WHEEL_STEP_COARSE,
  PITCH_STEP,
  UNKNOWN_STEM_COLOR,
  stemDisplayName as displayName,
} from "./constants.js";
import { mixerState } from "./state.js";
import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import {
  setLaneVolume,
  stepLanePitch,
  toggleStemMute,
  toggleStemSolo,
  updateLaneKnobVisual,
} from "./mixer.js";
import { paintLaneKey } from "./laneKey.js";
import { openLaneMenu, paintLaneMore } from "./laneMenu.js";
import { DOWNLOAD_ICON, stemDownloadLink } from "./laneDownload.js";

// A real minus sign: a hyphen beside a plus sign reads as a dash.
const MINUS_SIGN = "\u2212";

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
  btn.setAttribute("aria-pressed", String(mixerState[stemName]?.muted ?? false));
  btn.title = t("studio.lane.nameTitle", { name: displayName(stemName) });
  btn.addEventListener("click", function onLaneNameClick() { toggleStemMute(stemName); });
  return btn;
}

function muteButton(stemName) {
  const muted = mixerState[stemName]?.muted ?? false;
  const btn = button(`lane-icon-toggle mx-btn mute${muted ? " active" : ""}`, "M");
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
  const btn = button("lane-more");
  btn.dataset.stem = stemName;
  btn.innerHTML = icon("more");
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", function onLaneMoreClick() { openLaneMenu(stemName, btn); });
  paintLaneMore(btn, stemName);
  return btn;
}

function keyStep(stemName, direction) {
  const up = direction > 0;
  const btn = button(`lane-key-step ${up ? "up" : "down"}`, up ? "+" : MINUS_SIGN);
  btn.setAttribute("aria-label", t(up ? "aria.laneKeyUp" : "aria.laneKeyDown", { name: displayName(stemName) }));
  btn.addEventListener("click", function onLaneKeyStep() { stepLanePitch(stemName, direction); });
  return btn;
}

function keyStepper(stemName) {
  const wrap = el("div", "lane-key");
  wrap.dataset.stem = stemName;
  wrap.append(
    el("span", "lane-key-label", t("studio.lane.key")),
    keyStep(stemName, -PITCH_STEP),
    el("span", "lane-key-value"),
    keyStep(stemName, PITCH_STEP),
  );
  paintLaneKey(wrap, stemName);
  return wrap;
}

function stemDownload(stemName) {
  const link = stemDownloadLink(stemName);
  link.title = t("aria.download", { name: displayName(stemName) });
  link.innerHTML = DOWNLOAD_ICON;
  link.append(el("span", "lane-x-label", t("studio.lane.stem")));
  return link;
}

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

/** The header row for `stemName`; `eqMark` is the lane's EQ button. */
export function buildLaneHeader(stemName, eqMark) {
  const color = STEM_COLORS[stemName] || UNKNOWN_STEM_COLOR;
  const state = mixerState[stemName];
  const row = el("div", "lane-header mx-row lane-head");
  row.dataset.stem = stemName;
  row.style.setProperty("--lane-color", color);
  const main = el("div", "lane-main");
  const knob = fader(stemName, color);
  main.append(
    nameButton(stemName),
    muteButton(stemName),
    soloButton(stemName),
    knob,
    el("span", "mx-val"),
    moreButton(stemName),
  );
  const extra = el("div", "lane-x");
  extra.append(eqButton(eqMark), keyStepper(stemName), stemDownload(stemName));
  const body = el("div", "lane-body");
  body.append(main, extra);
  row.append(el("div", "lane-stripe"), body, meter(stemName));
  row.classList.toggle("muted", state?.muted ?? false);
  if (state) updateLaneKnobVisual(knob, state.volume);
  return row;
}
