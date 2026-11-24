// The recording tracks' rows in the mixer column; actions go to the handlers
// given to renderTakeRows, nothing here talks to the server.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { LANE_VOLUME_MAX } from "./constants.js";
import { updateLaneKnobVisual } from "./mixer.js";
import { ROW_ELSEWHERE, ROW_TAKE, ROW_UNFINISHED } from "./takesState.js";
import { fmtTickLabel } from "./utils.js";
import { vuLevel } from "./vuScale.js";

export const REC_ROW_SELECTOR = ".rec-row, .rec-take-row, .rec-add-row";
export const TRACK_ROW_SELECTOR = ".rec-row[data-rec-track]";
const SOLO_CLASS = "solo";
const ACTIVE_CLASS = "active";

const FADER_STEP = 0.01;
const WHEEL_STEP = 0.04;
const WHEEL_STEP_FINE = 0.2;
const UNITY = 1;

function button(className, { text = "", label = "", iconName = "" } = {}) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  if (iconName) el.innerHTML = icon(iconName);
  if (text) el.append(text);
  if (label) {
    el.setAttribute("aria-label", label);
    el.title = label;
  }
  return el;
}

function fader(view, mix, on) {
  const wrap = document.createElement("div");
  wrap.className = "lane-knob mx-fader";
  const input = document.createElement("input");
  input.type = "range";
  input.className = "mx-fader-input";
  input.min = "0";
  input.max = String(LANE_VOLUME_MAX);
  input.step = String(FADER_STEP);
  input.style.setProperty("--fader-color", "var(--rec-color)");
  input.setAttribute("aria-label", t("aria.volume", { name: view.name }));
  input.addEventListener("input", function onTakeFaderInput() {
    on.volume(view.id, parseFloat(input.value), wrap);
  });
  wrap.addEventListener("dblclick", function onTakeFaderReset() {
    on.volume(view.id, UNITY, wrap);
  });
  wrap.addEventListener("wheel", function onTakeFaderWheel(e) {
    e.preventDefault();
    const step = e.shiftKey ? WHEEL_STEP_FINE : WHEEL_STEP;
    on.volume(view.id, mix.volume - Math.sign(e.deltaY) * step, wrap);
  }, { passive: false });
  wrap.append(input);
  updateLaneKnobVisual(wrap, mix.volume);
  return wrap;
}

function nameLine(view, on) {
  const line = document.createElement("div");
  line.className = "rec-name-line";
  if (view.rows.length) {
    const folder = button("rec-folder-btn", { iconName: "down", label: t("rec.takesOf", { name: view.name }) });
    folder.setAttribute("aria-expanded", String(view.folderOpen));
    folder.addEventListener("click", function onFolderClick() { on.folder(view.id); });
    line.append(folder);
  }
  const name = document.createElement("span");
  name.className = "mx-name";
  name.textContent = view.name;
  line.append(name);
  return line;
}

function inputButton(view, inputLabel, on) {
  const btn = button("rec-input-btn", { iconName: "mic" });
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", t("rec.inputFor", { name: view.name }));
  const text = document.createElement("span");
  text.textContent = inputLabel || t("rec.defaultInput");
  btn.append(text);
  btn.insertAdjacentHTML("beforeend", icon("down"));
  btn.addEventListener("click", function onInputClick() { on.input(view.id, btn); });
  return btn;
}

function leftColumn(view, inputLabel, on) {
  const left = document.createElement("div");
  left.className = "rec-left";
  const meter = document.createElement("div");
  meter.className = "lane-vu mx-meter rec-meter";
  meter.innerHTML = '<div class="lane-vu-bar mx-meter-fill"></div>';
  left.append(nameLine(view, on), inputButton(view, inputLabel, on), meter);
  return left;
}

function paintSolo(solo, soloed) {
  solo.classList.toggle(ACTIVE_CLASS, soloed);
  solo.setAttribute("aria-pressed", String(soloed));
}

export function paintTrackSolo(row, soloed) {
  const solo = row.querySelector(`.${SOLO_CLASS}`);
  if (solo) paintSolo(solo, soloed);
}

function toggles(view, mix, armed, on) {
  const arm = button("rec-arm mx-btn", { label: t("rec.arm", { name: view.name }) });
  arm.setAttribute("aria-pressed", String(armed));
  arm.addEventListener("click", function onArmClick() { on.arm(view.id); });
  const mute = button(`lane-icon-toggle mx-btn mute${mix.muted ? "" : " active"}`, { text: "M" });
  mute.setAttribute("aria-label", t("aria.mute", { name: view.name }));
  mute.setAttribute("aria-pressed", String(mix.muted));
  mute.addEventListener("click", function onTakeMuteClick() { on.mute(view.id); });
  const solo = button(`${SOLO_CLASS} ms-btn mx-btn`, { text: "S" });
  solo.setAttribute("aria-label", t("aria.solo", { name: view.name }));
  paintSolo(solo, mix.soloed);
  solo.addEventListener("click", function onTakeSoloClick() { on.solo(view.id); });
  const more = button("lane-dl mx-btn rec-track-more", { iconName: "more", label: t("rec.trackOptions", { name: view.name }) });
  more.setAttribute("aria-haspopup", "menu");
  more.addEventListener("click", function onTrackMoreClick() { on.trackMenu(view.id, more); });
  return [arm, mute, solo, more];
}

function trackRow(view, ctx) {
  const mix = ctx.mixOf(view.id);
  const row = document.createElement("div");
  row.className = "lane-header mx-row rec-row";
  row.dataset.recTrack = view.id;
  row.classList.toggle("muted", mix.muted);
  row.classList.toggle("is-recording", ctx.recordingTrackId === view.id);
  row.append(
    leftColumn(view, ctx.inputLabelOf(view), ctx.on),
    fader(view, mix, ctx.on),
    ...toggles(view, mix, ctx.armedTrackId === view.id, ctx.on),
  );
  return row;
}

function chip(text, primary, onClick) {
  const el = button(`rec-chip${primary ? " is-primary" : ""}`, { text });
  el.addEventListener("click", onClick);
  return el;
}

function answerChips(takeRowView, on) {
  const wrap = document.createElement("span");
  wrap.className = "rec-review";
  wrap.append(
    chip(t("rec.keep"), true, function onKeepClick() { on.keep(takeRowView); }),
    chip(t("rec.delete"), false, function onDiscardClick() { on.discard(takeRowView); }),
  );
  return wrap;
}

// What an open take's row says instead of its length, and its tooltip.
const OPEN_ROW_TEXT = {
  [ROW_UNFINISHED]: { flag: "rec.unfinished", title: "rec.unfinishedTitle" },
  [ROW_ELSEWHERE]: { flag: "rec.elsewhere", title: "rec.elsewhereTitle" },
};

function pickButton(view, takeRowView, on) {
  const open = OPEN_ROW_TEXT[takeRowView.kind];
  const pick = button("rec-take-pick");
  pick.setAttribute("role", "radio");
  pick.setAttribute("aria-checked", String(Boolean(takeRowView.active)));
  pick.disabled = Boolean(open);
  pick.title = t(open ? open.title : "rec.playThisTake");
  const label = document.createElement("span");
  label.textContent = takeRowView.label;
  const meta = document.createElement("span");
  meta.className = open ? "rec-take-flag" : "rec-take-len";
  meta.textContent = open ? t(open.flag) : fmtTickLabel(takeRowView.durationSec);
  pick.append(label, meta);
  if (!open) pick.addEventListener("click", function onPickTake() { on.pick(view.id, takeRowView.id); });
  return pick;
}

function takeActions(takeRowView, on) {
  if (takeRowView.kind === ROW_ELSEWHERE) return [];
  if (takeRowView.review || takeRowView.kind === ROW_UNFINISHED) return [answerChips(takeRowView, on)];
  const del = button("lane-dl mx-btn rec-take-del", {
    iconName: "trash",
    label: t("rec.deleteTake", { name: takeRowView.label }),
  });
  del.addEventListener("click", function onDeleteTakeClick() { on.discard(takeRowView); });
  return [del];
}

function takeRow(view, takeRowView, on) {
  const row = document.createElement("div");
  row.className = "lane-header mx-row rec-take-row";
  row.dataset.recTake = takeRowView.id;
  row.classList.toggle("is-unfinished", takeRowView.kind !== ROW_TAKE);
  row.append(pickButton(view, takeRowView, on), ...takeActions(takeRowView, on));
  return row;
}

function addRow(on) {
  const row = document.createElement("div");
  row.className = "rec-add-row";
  const add = button("rec-add-btn", { iconName: "plus" });
  add.id = "recAddTrack";
  add.setAttribute("aria-haspopup", "menu");
  add.setAttribute("aria-expanded", "false");
  const text = document.createElement("span");
  text.textContent = t("rec.addTrack");
  add.append(text);
  add.addEventListener("click", function onAddTrackClick() { on.add(add); });
  row.append(add);
  return row;
}

/** Replace the recording rows in `mixerEl` with rows for `views`. */
export function renderTakeRows(mixerEl, views, ctx) {
  for (const el of mixerEl.querySelectorAll(REC_ROW_SELECTOR)) el.remove();
  const rows = [];
  for (const view of views) {
    rows.push(trackRow(view, ctx));
    if (view.folderOpen) rows.push(...view.rows.map((row) => takeRow(view, row, ctx.on)));
  }
  rows.push(addRow(ctx.on));
  mixerEl.append(...rows);
}

/** `rms` is the input's RMS amplitude. */
export function paintTrackMeter(mixerEl, trackId, rms) {
  const meter = mixerEl.querySelector(`.rec-row[data-rec-track="${trackId}"] .rec-meter`);
  meter?.style.setProperty("--vu-level", `${Math.round(vuLevel(rms) * 100)}%`);
}
