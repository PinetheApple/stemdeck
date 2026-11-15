// The loopback latency test: play clicks, capture them back on the same clock,
// and measure how late each one arrived. The arithmetic is in latency.js.

import { createPlaybackContext } from "./audioContext.js";
import { connectInput, startCapture } from "./recorderCapture.js";
import {
  CLICK_GAP_SEC,
  LATENCY_CLICKS,
  NOISE_LEAD_SEC,
  clickWaveform,
  measureLags,
  summariseLags,
} from "./latency.js";

const MONO_INPUT = [0];
// Time after the last click for its echo to arrive.
const TAIL_SEC = CLICK_GAP_SEC;
const START_TIMEOUT_MS = 3000;
const MS_PER_SEC = 1000;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playClicks(ctx, at) {
  const click = clickWaveform(ctx.sampleRate);
  const buffer = new AudioBuffer({ numberOfChannels: 1, length: click.length, sampleRate: ctx.sampleRate });
  buffer.copyToChannel(click, 0);
  const sources = [];
  for (let k = 0; k < LATENCY_CLICKS; k++) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(at + k * CLICK_GAP_SEC);
    sources.push(source);
  }
  return sources;
}

function joined(batches) {
  const out = new Float32Array(batches.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of batches) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

async function firstFrame(started) {
  const timeout = wait(START_TIMEOUT_MS).then(() => null);
  return Promise.race([started, timeout]);
}

/**
 * Runs the test on `stream`. `onHeard(count)` reports clicks heard so far;
 * `signal` (an AbortSignal) cancels it. Resolves with summariseLags' verdict
 * plus the context's sample rate, or null when cancelled.
 */
export async function runLatencyTest(stream, { onHeard, signal }) {
  const ctx = createPlaybackContext(window.AudioContext || window.webkitAudioContext);
  await ctx.resume();
  const input = connectInput(ctx, stream);
  const batches = [];
  let resolveStart;
  const started = new Promise((resolve) => { resolveStart = resolve; });
  const capture = await startCapture(input, MONO_INPUT, {
    onStart: (sec) => resolveStart(sec),
    onAudio: (samples) => batches.push(samples),
  });
  try {
    return await measure(ctx, await firstFrame(started), batches, { onHeard, signal });
  } finally {
    await capture.stop();
    input.disconnect();
    ctx.close().catch(() => {});
  }
}

async function measure(ctx, captureStart, batches, { onHeard, signal }) {
  if (captureStart === null) return { ok: false, heard: 0, roundTripMs: null, sampleRate: ctx.sampleRate };
  const firstClick = ctx.currentTime + NOISE_LEAD_SEC;
  playClicks(ctx, firstClick);
  const expected = [];
  for (let k = 0; k < LATENCY_CLICKS; k++) {
    expected.push(Math.round((firstClick + k * CLICK_GAP_SEC - captureStart) * ctx.sampleRate));
    const due = firstClick + k * CLICK_GAP_SEC + TAIL_SEC - ctx.currentTime;
    await wait(Math.max(0, due * MS_PER_SEC));
    if (signal?.aborted) return null;
    const lags = measureLags(joined(batches), ctx.sampleRate, expected);
    onHeard?.(lags.filter((lag) => lag !== null).length);
  }
  const verdict = summariseLags(measureLags(joined(batches), ctx.sampleRate, expected));
  return { ...verdict, sampleRate: ctx.sampleRate };
}
