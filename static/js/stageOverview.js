// Stage mode's song overview: the sections over a whole-song waveform, with the playhead and the times.

import { totalDuration } from "./state.js";
import { setPlayheadTime } from "./transport.js";
import { WAVE_PEAKS_EVENT, getWavePeaks } from "./player.js";
import { sectionSpans } from "./stageModel.js";
import { $, fmtTime } from "./utils.js";

const PERCENT = 100;
const BAR_GAP_PX = 1;
const MIN_BAR_PX = 2;
const WAVE_FILL = 0.8;
const PLAYED_TOKEN = "--accent";
const UNPLAYED_TOKEN = "--surface-4";

let blocks = [];
let wave = { canvasWidth: 0, playedBars: -1, peaks: null };
let painted = { current: null, elapsed: null, total: null, playhead: null };
let playedFraction = 0;
let resizeObserver = null;
let isShowing = () => false;

/** Draws the section blocks; `sections` are `{ start, end?, name }` in time order. */
export function paintStageSections(sections) {
  const strip = $("stageSections");
  if (!strip) return;
  const spans = sectionSpans(sections, totalDuration);
  blocks = spans.map(makeBlock);
  painted.current = null;
  strip.replaceChildren(...blocks);
}

function makeBlock(span) {
  const block = document.createElement("button");
  block.type = "button";
  block.className = "stage-sec";
  block.textContent = span.name;
  block.title = span.name;
  block.dataset.start = String(span.start);
  block.style.left = `${span.left}%`;
  block.style.width = `${span.width}%`;
  return block;
}

function markCurrent(index) {
  if (painted.current === index) return;
  painted.current = index;
  blocks.forEach((block, i) => {
    if (i === index) block.setAttribute("aria-current", "true");
    else block.removeAttribute("aria-current");
  });
}

function setText(id, key, text) {
  if (painted[key] === text) return;
  painted[key] = text;
  const el = $(id);
  if (el) el.textContent = text;
}

function drawWave(playedBars) {
  const canvas = $("stageWaveCanvas");
  const peaks = getWavePeaks();
  const width = canvas?.clientWidth ?? 0;
  if (!canvas || !width) return;
  wave = { canvasWidth: width, playedBars, peaks };
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!peaks?.length) return;
  const css = getComputedStyle(canvas);
  const colours = [css.getPropertyValue(PLAYED_TOKEN).trim(), css.getPropertyValue(UNPLAYED_TOKEN).trim()];
  drawBars(ctx, peaks, playedBars, colours);
}

function drawBars(ctx, peaks, playedBars, [played, unplayed]) {
  const { width, height } = ctx.canvas;
  const loudest = Math.max(...peaks.map(([low, high]) => Math.max(high, -low))) || 1;
  const barWidth = width / peaks.length;
  const gap = BAR_GAP_PX * (window.devicePixelRatio || 1);
  peaks.forEach(([low, high], i) => {
    const barHeight = Math.max(MIN_BAR_PX, ((high - low) / (2 * loudest)) * height * WAVE_FILL);
    const x = Math.round(i * barWidth);
    ctx.fillStyle = i < playedBars ? played : unplayed;
    ctx.fillRect(x, (height - barHeight) / 2, Math.max(1, Math.round(barWidth) - gap), barHeight);
  });
}

function paintWave(fraction) {
  const peaks = getWavePeaks();
  const playedBars = Math.floor(fraction * (peaks?.length ?? 0));
  const width = $("stageWaveCanvas")?.clientWidth ?? 0;
  const stale = wave.peaks !== peaks || wave.canvasWidth !== width || wave.playedBars !== playedBars;
  if (stale) drawWave(playedBars);
}

/** One frame of the overview at `time`; `currentIndex` is the section playing, or -1. */
export function paintStageOverview(time, currentIndex) {
  const duration = totalDuration;
  const fraction = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
  playedFraction = fraction;
  markCurrent(currentIndex);
  setText("stageElapsed", "elapsed", fmtTime(time));
  setText("stageTotal", "total", fmtTime(duration));
  const left = `${fraction * PERCENT}%`;
  if (painted.playhead !== left) {
    painted.playhead = left;
    const playhead = $("stagePlayhead");
    if (playhead) playhead.style.left = left;
  }
  paintWave(fraction);
}

/** Entering Stage or a new song: paint everything again on the next frame. */
export function forgetStageOverview() {
  painted = { current: null, elapsed: null, total: null, playhead: null };
  wave = { canvasWidth: 0, playedBars: -1, peaks: null };
}

function onSectionClick(e) {
  const block = e.target.closest(".stage-sec");
  if (block) setPlayheadTime(Number(block.dataset.start));
}

function onWaveClick(e) {
  const rect = e.currentTarget.getBoundingClientRect();
  if (!rect.width) return;
  setPlayheadTime(((e.clientX - rect.left) / rect.width) * totalDuration);
}

function onWaveChange() {
  if (!isShowing()) return;
  wave.canvasWidth = 0;
  paintWave(playedFraction);
}

/** `showing()` says whether Stage is on screen, so nothing redraws while it is not. */
export function initStageOverview(showing) {
  isShowing = showing;
  $("stageSections")?.addEventListener("click", onSectionClick);
  $("stageWave")?.addEventListener("click", onWaveClick);
  document.addEventListener(WAVE_PEAKS_EVENT, onWaveChange);
  resizeObserver ??= new ResizeObserver(onWaveChange);
  const waveEl = $("stageWave");
  if (waveEl) resizeObserver.observe(waveEl);
}
