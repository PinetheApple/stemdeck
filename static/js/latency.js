// The loopback latency test's arithmetic: the click it plays, where each click
// came back in the capture, and whether the answers agree well enough to keep.
// No Web Audio here, so it runs under node; latencyTest.js does the playing.

export const LATENCY_CLICKS = 5;
export const CLICK_GAP_SEC = 0.4;
export const NOISE_LEAD_SEC = 0.5;
export const MIN_HEARD = 4;
export const MAX_SPREAD_MS = 1;

const CLICK_SEC = 0.002;
const CLICK_SEED = 0x2545f491;
const NOISE_FACTOR = 4;
const MIN_THRESHOLD = 0.01;
// Lags past this share of the gap would be read as the next click's.
const SEARCH_SHARE = 0.9;
const MS_PER_SEC = 1000;

/** A short, windowed noise burst: wideband, so its echo lines up to the sample. */
export function clickWaveform(rate) {
  const n = Math.max(8, Math.round(rate * CLICK_SEC));
  const out = new Float32Array(n);
  let x = CLICK_SEED;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    const noise = ((x >>> 0) / 0xffffffff) * 2 - 1;
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = noise * hann;
  }
  return out;
}

function peakAbs(samples, from, to) {
  let peak = 0;
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

function firstAbove(samples, from, to, threshold) {
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i++) {
    if (Math.abs(samples[i]) >= threshold) return i;
  }
  return -1;
}

/** The start index near `coarse` where the click template matches best. */
function refineOnset(samples, coarse, click) {
  let best = coarse;
  let bestScore = -Infinity;
  for (let start = coarse - click.length; start <= coarse; start++) {
    if (start < 0 || start + click.length > samples.length) continue;
    let score = 0;
    for (let k = 0; k < click.length; k++) score += samples[start + k] * click[k];
    score = Math.abs(score);
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  return best;
}

/**
 * Each click's round trip in ms, or null for a click that never came back.
 * `expected` holds the capture index each click left the output at.
 */
export function measureLags(samples, rate, expected) {
  const click = clickWaveform(rate);
  const noiseEnd = expected[0] ?? 0;
  const threshold = Math.max(MIN_THRESHOLD, NOISE_FACTOR * peakAbs(samples, 0, noiseEnd));
  const window = Math.round(CLICK_GAP_SEC * SEARCH_SHARE * rate);
  return expected.map(function lagOf(at) {
    const coarse = firstAbove(samples, at, at + window, threshold);
    if (coarse < 0) return null;
    const onset = refineOnset(samples, coarse, click);
    return ((onset - at) / rate) * MS_PER_SEC;
  });
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The round trip the test settles on, and whether it can be trusted. */
export function summariseLags(lags) {
  const heard = lags.filter((lag) => lag !== null);
  if (heard.length < MIN_HEARD) return { ok: false, heard: heard.length, roundTripMs: null };
  const roundTripMs = median(heard);
  const spreadMs = median(heard.map((lag) => Math.abs(lag - roundTripMs)));
  return {
    ok: spreadMs <= MAX_SPREAD_MS,
    heard: heard.length,
    roundTripMs,
    spreadMs,
  };
}
