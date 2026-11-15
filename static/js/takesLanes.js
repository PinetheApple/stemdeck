// The recording tracks' lanes beside the waveforms, rebuilt with the rows so the
// two columns stay in step.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { ROW_TAKE, clipSpan, slicePeaks } from "./takesState.js";
import { SOURCE_ESTIMATED } from "./latencyStore.js";

const LAYER_CLASS = "rec-wave-layer";
const BAR_SLOT = 1;
const BAR_FRAC = 0.6;
const VIEW_H = 48;
const MID = VIEW_H / 2;
const MAX_BAR_H = VIEW_H - 4;
const MIN_BAR_H = 0.7;
const MIN_BARS = 12;
const BARS_PER_CLIP_SHARE = 150;
const BAR_RADIUS = 0.3;

export function waveLayer() {
  const column = document.querySelector(".waves-column");
  if (!column) return null;
  let layer = column.querySelector(`.${LAYER_CLASS}`);
  if (!layer) {
    layer = document.createElement("div");
    layer.className = LAYER_CLASS;
    column.append(layer);
  }
  return layer;
}

/** Mirrored bars like a stem lane's, each `amps` value in 0..1. */
export function barsSvg(amps) {
  const rects = amps.map(function bar(amp, i) {
    const h = Math.max(MIN_BAR_H, Math.min(1, amp) * MAX_BAR_H);
    return `<rect x="${(i + (1 - BAR_FRAC) / 2).toFixed(2)}" y="${(MID - h / 2).toFixed(2)}" `
      + `width="${BAR_FRAC}" height="${h.toFixed(2)}" rx="${BAR_RADIUS}"></rect>`;
  });
  return `<svg class="stem-waveform-svg" viewBox="0 0 ${amps.length * BAR_SLOT} ${VIEW_H}" `
    + `preserveAspectRatio="none" aria-hidden="true">${rects.join("")}</svg>`;
}

export function peakAmps(points, bars) {
  if (!points.length) return [];
  let max = 0;
  for (const [mn, mx] of points) max = Math.max(max, -mn, mx);
  const norm = max > 0 ? 1 / max : 0;
  return Array.from({ length: bars }, function ampAt(_, i) {
    const from = Math.floor((i * points.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * points.length) / bars));
    let amp = 0;
    for (let j = from; j < to && j < points.length; j++) amp = Math.max(amp, -points[j][0], points[j][1]);
    return amp * norm;
  });
}

function clipEl(span, name, points) {
  const clip = document.createElement("div");
  clip.className = "rec-clip";
  clip.style.left = `${span.start * 100}%`;
  clip.style.width = `${(span.end - span.start) * 100}%`;
  const label = document.createElement("span");
  label.className = "rec-clip-name";
  label.textContent = name;
  const bars = Math.max(MIN_BARS, Math.round(BARS_PER_CLIP_SHARE * (span.end - span.start)));
  clip.append(label);
  clip.insertAdjacentHTML("beforeend", barsSvg(peakAmps(slicePeaks(points, span), bars)));
  return clip;
}

function row(className, mutedOrInactive) {
  const el = document.createElement("div");
  el.className = `rec-lane ${className}`;
  if (mutedOrInactive) el.classList.add(mutedOrInactive);
  return el;
}

function problemEl(problem, onAction) {
  const box = document.createElement("div");
  box.className = "rec-problem";
  box.addEventListener("pointerdown", keepPointer);
  box.setAttribute("role", "alert");
  box.innerHTML = icon("alert");
  const text = document.createElement("p");
  text.textContent = t(`rec.problem.${problem}`);
  const action = document.createElement("button");
  action.type = "button";
  action.className = "settings-btn";
  action.textContent = t(`rec.problem.${problem}Action`);
  action.addEventListener("click", function onProblemAction() { onAction(problem, action); });
  box.append(text, action);
  return box;
}

// The waves column captures the pointer to drag a loop, which would swallow the click.
function keepPointer(e) {
  e.stopPropagation();
}

function latencyHintEl(trackId, onTest) {
  const box = document.createElement("div");
  box.className = "rec-latency-hint";
  box.addEventListener("pointerdown", keepPointer);
  const text = document.createElement("span");
  text.textContent = t("rec.latencyHint");
  const action = document.createElement("button");
  action.type = "button";
  action.className = "rec-latency-hint-btn";
  action.textContent = t("rec.latencyHintAction");
  action.addEventListener("click", function onLatencyHintClick() { onTest(trackId); });
  box.append(text, action);
  return box;
}

function trackLane(view, ctx) {
  const lane = row("rec-wave", ctx.mixOf(view.id).muted ? "is-muted" : "");
  lane.dataset.recTrack = view.id;
  const span = view.activeTake && clipSpan(view.activeTake, ctx.songSec);
  if (ctx.recordingTrackId === view.id) {
    lane.append(liveClipEl());
  } else if (span) {
    lane.append(clipEl(span, view.activeTake.label, ctx.peaksOf(view.activeTake.id)));
  } else if (ctx.armedTrackId === view.id && !ctx.problem) {
    const hint = document.createElement("span");
    hint.className = "rec-empty-hint";
    hint.textContent = t("rec.pressRecord");
    lane.append(hint);
  }
  if (ctx.armedTrackId === view.id && ctx.problem) {
    lane.append(problemEl(ctx.problem, ctx.on.problem));
  } else if (span && ctx.recordingTrackId !== view.id && view.activeTake.latency_source === SOURCE_ESTIMATED) {
    lane.append(latencyHintEl(view.id, ctx.on.latency));
  }
  return lane;
}

function liveClipEl() {
  const clip = document.createElement("div");
  clip.className = "rec-clip is-live";
  const label = document.createElement("span");
  label.className = "rec-clip-name";
  clip.append(label);
  return clip;
}

function takeLane(takeRowView, ctx) {
  const inactive = takeRowView.active ? "" : "is-inactive";
  const lane = row("rec-take-wave", inactive);
  lane.dataset.recTake = takeRowView.id;
  if (takeRowView.kind !== ROW_TAKE) return lane;
  const span = clipSpan(takeRowView.entry, ctx.songSec);
  if (span) lane.append(clipEl(span, takeRowView.label, ctx.peaksOf(takeRowView.id)));
  return lane;
}

/** Rebuild the lanes for `views`, in the same order as renderTakeRows. */
export function renderTakeLanes(views, ctx) {
  const layer = waveLayer();
  if (!layer) return;
  const lanes = [];
  for (const view of views) {
    lanes.push(trackLane(view, ctx));
    if (view.folderOpen) lanes.push(...view.rows.map((r) => takeLane(r, ctx)));
  }
  lanes.push(row("rec-add-wave", ""));
  layer.replaceChildren(...lanes);
}

/** Stretch the take being recorded from where it started to the playhead. */
export function paintLiveClip(trackId, { startSec, nowSec, songSec, peaks, label }) {
  const clip = waveLayer()?.querySelector(`.rec-wave[data-rec-track="${trackId}"] .rec-clip.is-live`);
  if (!clip || !(songSec > 0)) return;
  const start = Math.max(0, Math.min(startSec, nowSec)) / songSec;
  const end = Math.max(start, Math.min(songSec, nowSec) / songSec);
  clip.style.left = `${start * 100}%`;
  clip.style.width = `${(end - start) * 100}%`;
  clip.querySelector(".rec-clip-name").textContent = label;
  clip.querySelector("svg")?.remove();
  if (peaks.length) clip.insertAdjacentHTML("beforeend", barsSvg(peaks));
}
