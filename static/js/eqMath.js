// The export designs the same biquads from the same descriptor, so live and
// exported audio run identical filters; keep both sides in step.

import { clamp, finiteOr, gainToDb, roundTo } from "./audioMath.js";

export const EQ_ID = "eq";
export const EQ_VERSION = 1;

export const EQ_TYPES = Object.freeze([
  "bell",
  "lowshelf",
  "highshelf",
  "lowcut",
  "highcut",
  "notch",
  "bandpass",
  "tilt",
]);

/** Band types with a gain; at 0 dB they change nothing. */
export const EQ_GAIN_TYPES = new Set(["bell", "lowshelf", "highshelf", "tilt"]);

/** Cut slopes in dB per octave (cascaded Butterworth sections). */
export const EQ_SLOPES = Object.freeze([12, 24, 36, 48]);

export const EQ_LIMITS = Object.freeze({
  freqMin: 10,
  freqMax: 20000,
  gainMin: -30,
  gainMax: 30,
  qMin: 0.025,
  qMax: 40,
  outMin: -24,
  outMax: 24,
  maxBands: 12,
  maxUiChars: 4096,
});

/** Butterworth Q: a cut at this q has no resonance. */
export const EQ_DEFAULT_Q = 0.707;
/** The gentlest slope, and the slope of every non-cut band. */
export const EQ_PLAIN_SLOPE = 12;
/** The rate a response is drawn at when no engine is running. */
export const EQ_DEFAULT_RATE = 44100;

const DEFAULT_FREQ = 1000;
const FREQ_DIGITS = 1;
const GAIN_DIGITS = 2;
const Q_DIGITS = 3;
const DB_PER_ORDER = 6;
const SHELF_NODE_Q = 1;
const FX_WIRE_VERSION = 1;

const TYPE_ALIASES = {
  peaking: "bell",
  peak: "bell",
  highpass: "lowcut",
  lowpass: "highcut",
  hpf: "lowcut",
  lpf: "highcut",
};

/** A flat EQ: no bands, no output gain, not bypassed. */
export function flatEq() {
  return { id: EQ_ID, v: EQ_VERSION, bypass: false, params: { out: 0, bands: [] } };
}

function bandType(raw) {
  const type = typeof raw.type === "string" ? raw.type : "bell";
  const known = TYPE_ALIASES[type] || type;
  return EQ_TYPES.includes(known) ? known : null;
}

function nearestSlope(raw) {
  const slope = Math.round(finiteOr(raw, EQ_PLAIN_SLOPE));
  if (EQ_SLOPES.includes(slope)) return slope;
  return EQ_SLOPES.reduce(
    (best, s) => (Math.abs(s - slope) < Math.abs(best - slope) ? s : best),
    EQ_PLAIN_SLOPE,
  );
}

/**
 * One band, clamped and rounded to the precision the store and the export
 * carry (0.1 Hz, 0.01 dB, 0.001 Q). Null for something that is not a band.
 */
export function normalizeBand(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = bandType(raw);
  if (!type) return null;
  const L = EQ_LIMITS;
  return {
    on: raw.on !== false,
    type,
    f: roundTo(clamp(finiteOr(raw.f, DEFAULT_FREQ), L.freqMin, L.freqMax), FREQ_DIGITS),
    g: roundTo(clamp(finiteOr(raw.g, 0), L.gainMin, L.gainMax), GAIN_DIGITS),
    q: roundTo(clamp(finiteOr(raw.q, EQ_DEFAULT_Q), L.qMin, L.qMax), Q_DIGITS),
    slope: nearestSlope(raw.slope),
  };
}

function normalizeUi(ui) {
  if (ui === undefined || ui === null || typeof ui !== "object") return undefined;
  try {
    const text = JSON.stringify(ui);
    return text.length <= EQ_LIMITS.maxUiChars ? JSON.parse(text) : undefined;
  } catch (err) {
    console.warn("[eq] panel state is not serialisable, dropped:", err);
    return undefined;
  }
}

function isReadable(raw) {
  if (raw.id !== undefined && raw.id !== EQ_ID) return false;
  return (raw.v === undefined ? EQ_VERSION : raw.v) === EQ_VERSION;
}

/**
 * Any stored or incoming EQ descriptor, made safe: unknown fields dropped,
 * numbers clamped, at most maxBands bands. Another id or version reads flat.
 */
export function normalizeEq(raw) {
  const out = flatEq();
  if (!raw || typeof raw !== "object" || !isReadable(raw)) return out;
  out.bypass = raw.bypass === true;
  const params = raw.params && typeof raw.params === "object" ? raw.params : {};
  out.params.out = roundTo(clamp(finiteOr(params.out, 0), EQ_LIMITS.outMin, EQ_LIMITS.outMax), GAIN_DIGITS);
  const bands = Array.isArray(params.bands) ? params.bands : [];
  out.params.bands = bands.map(normalizeBand).filter(Boolean).slice(0, EQ_LIMITS.maxBands);
  const ui = normalizeUi(params.ui);
  if (ui !== undefined) out.params.ui = ui;
  return out;
}

/** True when a band changes nothing (so it is left out of the graph). */
export function bandIsNeutral(band) {
  if (!band.on) return true;
  return EQ_GAIN_TYPES.has(band.type) && band.g === 0;
}

/** True when the whole descriptor changes nothing: bypassed or all neutral. */
export function eqIsFlat(eq) {
  if (!eq || eq.bypass) return true;
  if (eq.params.out !== 0) return false;
  return eq.params.bands.every(bandIsNeutral);
}

/** Butterworth section Qs for an even order N, lowest first. */
export function butterworthQs(order) {
  const qs = [];
  for (let k = 1; k <= order / 2; k++) {
    qs.push(1 / (2 * Math.cos(((2 * k - 1) * Math.PI) / (2 * order))));
  }
  return qs.sort((a, b) => a - b);
}

function cutSections(band) {
  const type = band.type === "lowcut" ? "highpass" : "lowpass";
  const qs = butterworthQs(band.slope / DB_PER_ORDER);
  qs[qs.length - 1] *= band.q / EQ_DEFAULT_Q;
  return qs.map((q) => ({ type, f: band.f, q, g: 0 }));
}

const SECTIONS_BY_TYPE = {
  bell: ({ f, q, g }) => [{ type: "peaking", f, q, g }],
  lowshelf: ({ f, g }) => [{ type: "lowshelf", f, q: 0, g }],
  highshelf: ({ f, g }) => [{ type: "highshelf", f, q: 0, g }],
  notch: ({ f, q }) => [{ type: "notch", f, q, g: 0 }],
  bandpass: ({ f, q }) => [{ type: "bandpass", f, q, g: 0 }],
  tilt: ({ f, g }) => [
    { type: "lowshelf", f, q: 0, g: -g / 2 },
    { type: "highshelf", f, q: 0, g: g / 2 },
  ],
  lowcut: cutSections,
  highcut: cutSections,
};

/**
 * The biquad sections of one band: [{type, f, q, g}], `type` a
 * BiquadFilterNode type and `q` linear. A cut's q scales its sharpest
 * section, so q = 0.707 is plain Butterworth.
 */
export function bandSections(band) {
  if (bandIsNeutral(band)) return [];
  return SECTIONS_BY_TYPE[band.type]?.(band) || [];
}

/** All sections of an EQ in processing order (empty when bypassed). */
export function eqSections(eq) {
  if (!eq || eq.bypass) return [];
  return eq.params.bands.flatMap(bandSections);
}

/** The value for BiquadFilterNode.Q: dB for lowpass/highpass, ignored for shelves. */
export function nodeQ(section) {
  if (section.type === "lowpass" || section.type === "highpass") return gainToDb(section.q);
  if (section.type === "lowshelf" || section.type === "highshelf") return SHELF_NODE_Q;
  return section.q;
}

const LOW = 1;
const HIGH = -1;

function passCoefs({ cw, alphaQdB }, side) {
  const edge = (1 - side * cw) / 2;
  return [edge, side * 2 * edge, edge, 1 + alphaQdB, -2 * cw, 1 - alphaQdB];
}

function shelfCoefs({ A, cw, k }, side) {
  const tilt = side * (A - 1) * cw;
  return [
    A * ((A + 1) - tilt + k),
    side * 2 * A * ((A - 1) - side * (A + 1) * cw),
    A * ((A + 1) - tilt - k),
    (A + 1) + tilt + k,
    -side * 2 * ((A - 1) + side * (A + 1) * cw),
    (A + 1) + tilt - k,
  ];
}

const RAW_COEFS = {
  lowpass: (w) => passCoefs(w, LOW),
  highpass: (w) => passCoefs(w, HIGH),
  bandpass: ({ cw, alphaQ }) => [alphaQ, 0, -alphaQ, 1 + alphaQ, -2 * cw, 1 - alphaQ],
  notch: ({ cw, alphaQ }) => [1, -2 * cw, 1, 1 + alphaQ, -2 * cw, 1 - alphaQ],
  peaking: ({ A, cw, alphaQ }) => [
    1 + alphaQ * A,
    -2 * cw,
    1 - alphaQ * A,
    1 + alphaQ / A,
    -2 * cw,
    1 - alphaQ / A,
  ],
  lowshelf: (w) => shelfCoefs(w, LOW),
  highshelf: (w) => shelfCoefs(w, HIGH),
};

function warp(section, fs) {
  const f0 = Math.min(Math.max(section.f, 0), fs / 2);
  const A = 10 ** (section.g / 40);
  const w0 = (2 * Math.PI * f0) / fs;
  const sw = Math.sin(w0);
  return {
    A,
    cw: Math.cos(w0),
    alphaQ: sw / (2 * section.q),
    alphaQdB: sw / (2 * 10 ** (nodeQ(section) / 20)),
    k: sw * Math.SQRT2 * Math.sqrt(A),
  };
}

/** Normalised coefficients (a0 = 1) of one section at sample rate `fs`. */
export function sectionCoefs(section, fs) {
  const design = RAW_COEFS[section.type];
  if (!design) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  const [b0, b1, b2, a0, a1, a2] = design(warp(section, fs));
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** |H| in dB of one set of normalised coefficients at frequency f. */
export function coefsMagDb(c, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const [c1, s1, c2, s2] = [Math.cos(w), Math.sin(w), Math.cos(2 * w), Math.sin(2 * w)];
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
  const ni = -(c.b1 * s1 + c.b2 * s2);
  const dr = 1 + c.a1 * c1 + c.a2 * c2;
  const di = -(c.a1 * s1 + c.a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

function sumResponse(sections, freqs, fs, offsetDb) {
  const coefs = sections.map((s) => sectionCoefs(s, fs));
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    out[i] = coefs.reduce((db, c) => db + coefsMagDb(c, freqs[i], fs), offsetDb);
  }
  return out;
}

/** Magnitude response of a whole EQ in dB, output gain included. Flat: zeros. */
export function eqResponseDb(eq, freqs, fs = EQ_DEFAULT_RATE) {
  if (!eq || eq.bypass) return new Float64Array(freqs.length);
  return sumResponse(eqSections(eq), freqs, fs, eq.params.out);
}

/**
 * The export wire form of one EQ, or null when it changes nothing:
 * {id: "eq", out, b: [[type, f, g, q, slope], ...]}.
 */
export function eqToWire(eq) {
  if (eqIsFlat(eq)) return null;
  const b = eq.params.bands
    .filter((band) => !bandIsNeutral(band))
    .map((band) => [band.type, band.f, band.g, band.q, band.slope]);
  return { id: EQ_ID, out: eq.params.out, b };
}

/** base64url without padding, of a UTF-8 string. */
export function base64UrlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  const bin = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The `fx=` export parameter: base64url JSON {v, lanes: {name: [eq]},
 * master: [eq]}, or "" when nothing in it changes the sound.
 */
export function encodeFxParam(lanes, master = null) {
  const outLanes = {};
  for (const [name, eq] of Object.entries(lanes || {})) {
    const wire = eqToWire(eq);
    if (wire) outLanes[name] = [wire];
  }
  const body = { v: FX_WIRE_VERSION, lanes: outLanes };
  const masterWire = master ? eqToWire(master) : null;
  if (masterWire) body.master = [masterWire];
  const any = masterWire || Object.keys(outLanes).length;
  return any ? base64UrlEncode(JSON.stringify(body)) : "";
}
