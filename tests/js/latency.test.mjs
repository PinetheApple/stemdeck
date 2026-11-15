// The loopback latency test's measurement and verdict (#98).
//
// Run:  node tests/js/latency.test.mjs

import {
  CLICK_GAP_SEC,
  LATENCY_CLICKS,
  NOISE_LEAD_SEC,
  clickWaveform,
  measureLags,
  median,
  summariseLags,
} from "../../static/js/latency.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
}

const RATE = 48000;
const ROUND_TRIP_MS = 23.4;
const ECHO_GAIN = 0.3;
const NOISE = 0.002;
const SMOOTHING = 0.6;

function seededNoise(seed) {
  let x = seed;
  return () => {
    x = (x * 16807) % 2147483647;
    return (x / 2147483647) * 2 - 1;
  };
}

/** A capture with each click coming back `lagMs[k]` late, lowpassed like a speaker and mic would. */
function capture(lagMs, { gain = ECHO_GAIN } = {}) {
  const expected = lagMs.map((_, k) => Math.round((NOISE_LEAD_SEC + k * CLICK_GAP_SEC) * RATE));
  const length = expected.at(-1) + RATE;
  const samples = new Float32Array(length);
  const rnd = seededNoise(7);
  for (let i = 0; i < length; i++) samples[i] = NOISE * rnd();
  const click = clickWaveform(RATE);
  lagMs.forEach((lag, k) => {
    if (lag === null) return;
    const at = expected[k] + Math.round((lag / 1000) * RATE);
    click.forEach((v, i) => { samples[at + i] += gain * v; });
  });
  let prev = 0;
  for (let i = 0; i < length; i++) {
    prev = SMOOTHING * prev + (1 - SMOOTHING) * samples[i];
    samples[i] = prev;
  }
  return { samples, expected };
}

const SAMPLE_MS = 1000 / RATE;

{
  const { samples, expected } = capture(Array(LATENCY_CLICKS).fill(ROUND_TRIP_MS));
  const lags = measureLags(samples, RATE, expected);
  const verdict = summariseLags(lags);
  check("every click is heard", lags.every((lag) => lag !== null), JSON.stringify(lags));
  check(
    "the round trip is found within a sample",
    verdict.ok && Math.abs(verdict.roundTripMs - ROUND_TRIP_MS) <= SAMPLE_MS,
    JSON.stringify(verdict),
  );
}

{
  const { samples, expected } = capture([20, 20.1, 19.9, null, 20]);
  const verdict = summariseLags(measureLags(samples, RATE, expected));
  check("one missed click still passes", verdict.ok && verdict.heard === 4, JSON.stringify(verdict));
}

{
  const { samples, expected } = capture([20, null, null, 20, 20]);
  const verdict = summariseLags(measureLags(samples, RATE, expected));
  check("too few clicks fail", !verdict.ok && verdict.heard === 3, JSON.stringify(verdict));
}

{
  const { samples, expected } = capture([10, 14, 30, 45, 60]);
  const verdict = summariseLags(measureLags(samples, RATE, expected));
  check("scattered answers fail", !verdict.ok, JSON.stringify(verdict));
}

{
  const { samples, expected } = capture(Array(LATENCY_CLICKS).fill(ROUND_TRIP_MS), { gain: 0 });
  const verdict = summariseLags(measureLags(samples, RATE, expected));
  check("silence fails", !verdict.ok && verdict.heard === 0, JSON.stringify(verdict));
}

check("median of an even count", median([4, 1, 3, 2]) === 2.5);
check("median of an odd count", median([5, 1, 3]) === 3);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
