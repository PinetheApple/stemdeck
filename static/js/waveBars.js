// Whole-song waveform bars from `[min, max]` peaks, shared by the footer strip and Stage's overview.

const DEFAULT_DPR = 1;
const BAR_GAP_PX = 1;
const MIN_BAR_WIDTH_PX = 1;
const SILENT_NORM = 1;

/** Canvas pixels per CSS pixel. */
export function deviceScale() {
  return window.devicePixelRatio || DEFAULT_DPR;
}

/**
 * Sizes the canvas's backing store to its box at the device pixel ratio and clears it.
 * Returns its 2D context, or null while the canvas has no size to draw into.
 */
export function fitWaveCanvas(canvas) {
  const dpr = deviceScale();
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return ctx;
}

function loudestPeak(peaks) {
  let loudest = 0;
  for (const [low, high] of peaks) {
    if (high > loudest) loudest = high;
    if (-low > loudest) loudest = -low;
  }
  return loudest;
}

/**
 * One bar per peak across the canvas, the first `playedBars` in `playedColor`.
 * `fill` is the share of half the height the loudest peak reaches; `minBarHeight` is in canvas pixels.
 */
export function drawWaveBars(ctx, peaks, { playedBars, playedColor, restColor, fill, minBarHeight }) {
  const { width, height } = ctx.canvas;
  const n = peaks.length;
  const loudest = loudestPeak(peaks);
  const norm = loudest > 0 ? 1 / loudest : SILENT_NORM;
  const cy = height / 2;
  const barW = width / n;
  for (let i = 0; i < n; i++) {
    const [low, high] = peaks[i];
    const top = cy - high * norm * cy * fill;
    const bot = cy - low * norm * cy * fill;
    const x = Math.round(i * barW);
    const nextX = i === n - 1 ? width : Math.round((i + 1) * barW);
    ctx.fillStyle = i < playedBars ? playedColor : restColor;
    ctx.fillRect(x, top, Math.max(MIN_BAR_WIDTH_PX, nextX - x - BAR_GAP_PX), Math.max(minBarHeight, bot - top));
  }
}
