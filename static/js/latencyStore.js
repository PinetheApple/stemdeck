// Measured round trips, per output and input device pair. They belong to this
// browser and its devices, not to the server: a phone and a desktop each keep
// their own. When a pair was never tested the context's reported latencies
// stand in, and the take records which of the two it used.

import { storeGet, storeSet } from "./utils.js";

export const LATENCY_STORE_KEY = "stemdeck:latency:v1";
export const DEFAULT_OUTPUT = "default";
export const SOURCE_CALIBRATED = "calibrated";
export const SOURCE_ESTIMATED = "estimated";

const MS_PER_SEC = 1000;

export function pairKey(outputId, inputId) {
  return `${outputId || DEFAULT_OUTPUT}|${inputId || ""}`;
}

export async function savedRoundTrip(inputId) {
  const saved = await storeGet(LATENCY_STORE_KEY, {});
  return saved?.[pairKey(DEFAULT_OUTPUT, inputId)] ?? null;
}

export async function saveRoundTrip(inputId, roundTripMs, sampleRate) {
  const saved = (await storeGet(LATENCY_STORE_KEY, {})) || {};
  saved[pairKey(DEFAULT_OUTPUT, inputId)] = {
    round_trip_ms: roundTripMs,
    measured_at: Date.now() / MS_PER_SEC,
    sample_rate: sampleRate,
  };
  return storeSet(LATENCY_STORE_KEY, saved);
}

function ms(sec) {
  return Number.isFinite(sec) ? sec * MS_PER_SEC : 0;
}

/** The latency block of a new take: the tested round trip, else the reported one. */
export function takeLatency(ctx, inputLatencySec, saved) {
  const outputMs = ms(ctx.outputLatency);
  const baseMs = ms(ctx.baseLatency);
  if (saved) {
    return {
      round_trip_ms: saved.round_trip_ms,
      source: SOURCE_CALIBRATED,
      output_latency_ms: outputMs,
      base_latency_ms: baseMs,
    };
  }
  return {
    round_trip_ms: outputMs + baseMs + ms(inputLatencySec),
    source: SOURCE_ESTIMATED,
    output_latency_ms: outputMs,
    base_latency_ms: baseMs,
  };
}
