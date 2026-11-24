// Stage mode's song overview: the sections over a whole-song waveform, with the playhead and the times.

import { loopEnabled, loopEnd, loopStart, totalDuration } from "./state.js";
import { setLoopRange, setPlayheadTime, toggleLoop } from "./transport.js";
import { WAVE_PEAKS_EVENT, getWavePeaks } from "./player.js";
import { PERCENT, sectionSpans, setTextOnce } from "./stageModel.js";
import { deviceScale, fitWaveCanvas, drawWaveBars } from "./waveBars.js";
import { t } from "./i18n.js";
import { $, fmtTime } from "./utils.js";

const MIN_BAR_PX = 2;
const WAVE_FILL = 0.8;
const PLAYED_TOKEN = "--accent";
const UNPLAYED_TOKEN = "--surface-4";
const SECTION_CLASS = "stage-sec";
const SECTION_GO_CLASS = "stage-sec-go";
const SECTION_LOOP_CLASS = "stage-sec-loop";

const freshWave = () => ({ canvasWidth: 0, playedBars: -1, peaks: null });
const freshPainted = () => ({ current: null, elapsed: null, total: null, playhead: null, loop: null });

let blocks = [];
let wave = freshWave();
let painted = freshPainted();
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
  painted.loop = null;
  strip.replaceChildren(...blocks);
}

function blockButton(className, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.title = title;
  return button;
}

function goButton(span) {
  const go = blockButton(SECTION_GO_CLASS, t("stage.jumpTo", { name: span.name }));
  const name = document.createElement("span");
  name.className = "stage-sec-name";
  name.textContent = span.name;
  const time = document.createElement("span");
  time.className = "stage-sec-time num";
  time.textContent = fmtTime(span.start);
  go.append(name, time);
  return go;
}

function loopButton(span) {
  const loop = blockButton(SECTION_LOOP_CLASS, t("stage.loopSection", { name: span.name }));
  loop.setAttribute("aria-label", loop.title);
  loop.setAttribute("aria-pressed", "false");
  loop.append($("stageLoopIcon").content.cloneNode(true));
  return loop;
}

function makeBlock(span) {
  const block = document.createElement("div");
  block.className = SECTION_CLASS;
  block.dataset.start = String(span.start);
  block.dataset.end = String(span.end);
  block.style.left = `${span.left}%`;
  block.style.width = `${span.width}%`;
  block.append(goButton(span), loopButton(span));
  return block;
}

const isLooped = (block) => loopEnabled
  && loopStart === Number(block.dataset.start)
  && loopEnd === Number(block.dataset.end);

function markLoop() {
  const key = loopEnabled ? `${loopStart}-${loopEnd}` : "";
  if (painted.loop === key) return;
  painted.loop = key;
  for (const block of blocks) {
    block.querySelector(`.${SECTION_LOOP_CLASS}`).setAttribute("aria-pressed", String(isLooped(block)));
  }
}

function markCurrent(index) {
  if (painted.current === index) return;
  painted.current = index;
  blocks.forEach((block, i) => {
    if (i === index) block.setAttribute("aria-current", "true");
    else block.removeAttribute("aria-current");
  });
}

function drawWave(playedBars) {
  const canvas = $("stageWaveCanvas");
  const peaks = getWavePeaks();
  const ctx = canvas && fitWaveCanvas(canvas);
  if (!ctx) return;
  wave = { canvasWidth: canvas.clientWidth, playedBars, peaks };
  if (!peaks?.length) return;
  const css = getComputedStyle(canvas);
  drawWaveBars(ctx, peaks, {
    playedBars,
    playedColor: css.getPropertyValue(PLAYED_TOKEN).trim(),
    restColor: css.getPropertyValue(UNPLAYED_TOKEN).trim(),
    fill: WAVE_FILL,
    minBarHeight: MIN_BAR_PX * deviceScale(),
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
  markLoop();
  setTextOnce(painted, "elapsed", $("stageElapsed"), fmtTime(time));
  setTextOnce(painted, "total", $("stageTotal"), fmtTime(duration));
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
  painted = freshPainted();
  wave = freshWave();
}

function onSectionClick(e) {
  const block = e.target.closest(`.${SECTION_CLASS}`);
  if (!block) return;
  if (!e.target.closest(`.${SECTION_LOOP_CLASS}`)) setPlayheadTime(Number(block.dataset.start));
  else if (isLooped(block)) toggleLoop();
  else setLoopRange(Number(block.dataset.start), Number(block.dataset.end));
  markLoop();
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
