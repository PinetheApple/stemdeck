// bypass true is "mastering off": the settings stay saved so switching back
// on restores them, but nothing is applied live or in an export.

import { clamp, dbToGain, finiteOr, gainToDb, roundTo } from "./audioMath.js";
import { base64UrlEncode } from "./eqMath.js";

export const MASTER_ID = "master";
export const MASTER_VERSION = 1;

export const MASTER_LIMITS = Object.freeze({
  targetMin: -24,
  targetMax: -6,
  ceilingMin: -3,
  ceilingMax: -0.1,
  compMin: 0,
  compMax: 1,
});

/** Lossy exports never go above this ceiling. */
export const LOSSY_CEILING_DBTP = -1.5;
/** The limiter sits this far under the ceiling. */
export const LIMITER_MARGIN_DB = 0.1;

/** What the A/B compare plays. */
export const LISTEN = Object.freeze({ master: "master", original: "original" });

/** target null: no loudness change, only the limiter. */
export const MASTER_PRESETS = Object.freeze({
  gentle: { target: null, ceiling: -1, comp: 0 },
  streaming: { target: -14, ceiling: -1, comp: 0 },
  louder: { target: -9, ceiling: -1, comp: 0.5 },
  custom: { target: -14, ceiling: -1, comp: 0 },
});
export const PRESET_ORDER = Object.freeze(["gentle", "streaming", "louder", "custom"]);
export const DEFAULT_PRESET = "streaming";
const CUSTOM = "custom";

const TARGET_DIGITS = 1;
const CEILING_DIGITS = 1;
const COMP_DIGITS = 2;
const RATIO_DIGITS = 3;
const COMP_RATIO_PER_AMOUNT = 2;
/** The glue compressor's attack and release in seconds. */
export const GLUE_TIMING = Object.freeze({ attack: 0.02, release: 0.25 });
const GLUE = Object.freeze({ knee: 6, ...GLUE_TIMING });
const LIMITER = Object.freeze({ ratio: 20, knee: 0, attack: 0.002, release: 0.05 });
const MATCH_CLAMP_LU = 40;
const LUFS_OFFSET = -0.691;

const { compMin, compMax } = MASTER_LIMITS;
const roundComp = (v, fallback) => roundTo(clamp(finiteOr(v, fallback), compMin, compMax), COMP_DIGITS);

/** A descriptor with the defaults: streaming, on. */
export function defaultMaster() {
  const p = MASTER_PRESETS[DEFAULT_PRESET];
  return {
    id: MASTER_ID,
    v: MASTER_VERSION,
    bypass: false,
    params: { preset: DEFAULT_PRESET, target_lufs: p.target, ceiling_dbtp: p.ceiling, comp: p.comp },
  };
}

function customParams(p) {
  const L = MASTER_LIMITS;
  const fallback = MASTER_PRESETS[CUSTOM];
  return {
    preset: CUSTOM,
    target_lufs: p.target_lufs === null
      ? null
      : roundTo(clamp(finiteOr(p.target_lufs, fallback.target), L.targetMin, L.targetMax), TARGET_DIGITS),
    ceiling_dbtp: roundTo(clamp(finiteOr(p.ceiling_dbtp, fallback.ceiling), L.ceilingMin, L.ceilingMax), CEILING_DIGITS),
    comp: roundComp(p.comp, fallback.comp),
  };
}

/**
 * Clamp, round and fill in a descriptor. A missing one, or one of another id
 * or version, reads as off with the defaults. A named preset carries its own
 * target and ceiling; the compressor amount is always the user's.
 */
export function normalizeMaster(raw) {
  const out = defaultMaster();
  if (!raw || typeof raw !== "object" || raw.v !== MASTER_VERSION || raw.id !== MASTER_ID) {
    out.bypass = true;
    return out;
  }
  out.bypass = raw.bypass === true;
  const p = raw.params && typeof raw.params === "object" ? raw.params : {};
  const preset = PRESET_ORDER.includes(p.preset) ? p.preset : DEFAULT_PRESET;
  if (preset === CUSTOM) {
    out.params = customParams(p);
    return out;
  }
  const def = MASTER_PRESETS[preset];
  out.params = { preset, target_lufs: def.target, ceiling_dbtp: def.ceiling, comp: roundComp(p.comp, def.comp) };
  return out;
}

function presetParams(current, preset) {
  const def = MASTER_PRESETS[preset] || MASTER_PRESETS[DEFAULT_PRESET];
  if (preset !== CUSTOM) return { preset, target_lufs: def.target, ceiling_dbtp: def.ceiling, comp: def.comp };
  if (current.preset === CUSTOM) return current;
  return {
    preset,
    target_lufs: current.target_lufs ?? def.target,
    ceiling_dbtp: current.ceiling_dbtp,
    comp: current.comp,
  };
}

/** The descriptor after picking a preset; custom starts from the current numbers. */
export function applyPreset(desc, preset) {
  const current = normalizeMaster(desc);
  return normalizeMaster({ ...current, params: presetParams(current.params, preset) });
}

export function masterIsOn(desc) {
  return !!desc && desc.bypass !== true;
}

/** The export `master=` parameter, "" when off. */
export function encodeMasterParam(desc) {
  const m = normalizeMaster(desc);
  if (!masterIsOn(m)) return "";
  const body = { v: MASTER_VERSION, target: m.params.target_lufs, ceiling: m.params.ceiling_dbtp };
  if (m.params.comp > 0) body.comp = m.params.comp;
  return base64UrlEncode(JSON.stringify(body));
}

// Chromium's DynamicsCompressorNode static curve, in float32 as Blink computes it.
const MAKEUP_POWER = 0.6;
const SLOPE_PROBE = 1.001;
const KNEE_SEARCH = Object.freeze({ min: 0.1, max: 10000, start: 5, steps: 15 });
const SILENT_DB = -1000;
const f32 = Math.fround;
const linToDb = (x) => (x ? f32(gainToDb(x)) : SILENT_DB);
const dbToLin = (db) => f32(dbToGain(db));

function kneeCurve(x, k, linearThreshold) {
  if (x < linearThreshold) return x;
  return f32(linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k);
}

function slopeAt(x, k, linearThreshold) {
  if (x < linearThreshold) return 1;
  const x2 = f32(x * SLOPE_PROBE);
  const dy = linToDb(kneeCurve(x2, k, linearThreshold)) - linToDb(kneeCurve(x, k, linearThreshold));
  return f32(dy / (linToDb(x2) - linToDb(x)));
}

function kneeAtSlope(desired, thresholdDb, kneeDb) {
  const x = dbToLin(thresholdDb + kneeDb);
  const linearThreshold = dbToLin(thresholdDb);
  let [minK, maxK, k] = [KNEE_SEARCH.min, KNEE_SEARCH.max, KNEE_SEARCH.start];
  for (let i = 0; i < KNEE_SEARCH.steps; i++) {
    if (slopeAt(x, k, linearThreshold) < desired) maxK = k;
    else minK = k;
    k = f32(Math.sqrt(minK * maxK));
  }
  return k;
}

/**
 * The fixed makeup gain the Web Audio spec makes every compressor apply
 * ("the 0.6 power of full range makeup gain"), from Blink's knee curve. The
 * live master cancels it with a GainNode of the inverse.
 */
export function compressorMakeupGain(thresholdDb, kneeDb, ratio) {
  const slope = f32(1 / ratio);
  const k = kneeAtSlope(slope, thresholdDb, kneeDb);
  const linearThreshold = dbToLin(thresholdDb);
  const kneeThresholdDb = f32(thresholdDb + kneeDb);
  const kneeThreshold = dbToLin(kneeThresholdDb);
  const yKneeDb = linToDb(kneeCurve(kneeThreshold, k, linearThreshold));
  const fullRange = kneeThreshold > 1
    ? kneeCurve(1, k, linearThreshold)
    : dbToLin(yKneeDb + slope * (0 - kneeThresholdDb));
  return f32((1 / fullRange) ** MAKEUP_POWER);
}

/** Glue compressor settings for an amount, null when off. */
export function glueSettings(comp, thresholdDb) {
  if (!(comp > 0) || !Number.isFinite(thresholdDb)) return null;
  const ratio = roundTo(1 + COMP_RATIO_PER_AMOUNT * comp, RATIO_DIGITS);
  return { threshold: thresholdDb, ratio, ...GLUE };
}

/** The live limiter: the export's limit at ratio 20, the spec's maximum. */
export function limiterSettings(ceilingDb) {
  return { threshold: ceilingDb - LIMITER_MARGIN_DB, ...LIMITER };
}

/**
 * Loudness-matched levels {master, original}: the louder of the two is
 * turned down by `diffLu` (master minus original).
 */
export function matchedLevels(diffLu, match = true) {
  if (!match || !Number.isFinite(diffLu)) return { master: 1, original: 1 };
  const d = clamp(diffLu, -MATCH_CLAMP_LU, MATCH_CLAMP_LU);
  return d >= 0 ? { master: dbToGain(-d), original: 1 } : { master: 1, original: dbToGain(d) };
}

const K_SHELF = Object.freeze({ gainDb: 4, q: Math.SQRT1_2, freq: 1500 });
const K_HIGHPASS = Object.freeze({ q: 0.5, freq: 38 });

function kShelf(fs) {
  const A = 10 ** (K_SHELF.gainDb / 40);
  const w0 = (2 * Math.PI * K_SHELF.freq) / fs;
  const alpha = Math.sin(w0) / (2 * K_SHELF.q);
  const c = Math.cos(w0);
  const k = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * c + k;
  return {
    feedforward: [
      A * ((A + 1) + (A - 1) * c + k),
      -2 * A * ((A - 1) + (A + 1) * c),
      A * ((A + 1) + (A - 1) * c - k),
    ].map((v) => v / a0),
    feedback: [1, (2 * ((A - 1) - (A + 1) * c)) / a0, ((A + 1) - (A - 1) * c - k) / a0],
  };
}

function kHighpass(fs) {
  const w0 = (2 * Math.PI * K_HIGHPASS.freq) / fs;
  const alpha = Math.sin(w0) / (2 * K_HIGHPASS.q);
  const c = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    feedforward: [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0],
    feedback: [1, (-2 * c) / a0, (1 - alpha) / a0],
  };
}

/** BS.1770 K-weighting as IIRFilterNode coefficients: a +4 dB shelf at 1.5 kHz and a 38 Hz high-pass. */
export function kWeightingCoefficients(fs) {
  return { shelf: kShelf(fs), highpass: kHighpass(fs) };
}

/** Mean square of the last `n` samples of a buffer. */
export function meanSquareTail(buf, n) {
  const len = Math.min(n, buf.length);
  let sum = 0;
  for (let i = buf.length - len; i < buf.length; i++) sum += buf[i] * buf[i];
  return len ? sum / len : 0;
}

/** Momentary loudness (LUFS) from K-weighted per-channel mean squares. */
export function loudnessFromMeanSquares(channels) {
  const total = channels.reduce((a, b) => a + b, 0);
  return total > 0 ? LUFS_OFFSET + 10 * Math.log10(total) : -Infinity;
}

/** Largest absolute sample as dBFS (-Infinity for silence). */
export function peakDb(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  return peak > 0 ? gainToDb(peak) : -Infinity;
}

/** A meter value that rises at once and falls at most `fallDb` per update. */
export function holdFall(prev, next, fallDb) {
  if (!Number.isFinite(prev) || next >= prev) return next;
  return Math.max(next, prev - fallDb);
}
