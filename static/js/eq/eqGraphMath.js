// The graphical EQ editor, the pure part: axis mapping, hit testing, drag,
// wheel and key maths, band defaults, number formats and parsing, undo
// history, and the spectrum's bin-to-pixel map. No DOM.

import { EQ_DEFAULT_Q, EQ_LIMITS, EQ_VERSION, normalizeBand } from "../eqMath.js";

export const F_MIN = 20;
export const F_MAX = 20000;
/** The graph shows +-DB_RANGE dB; a drag keeps a band's gain inside it. */
export const DB_RANGE = 18;
/** The spectrum's floor and top in dB per FFT bin (8192-point FFT of a stem). */
export const SPEC_MIN_DB = -115;
export const SPEC_MAX_DB = -35;
/** Display tilt in dB per octave around 1 kHz, so the highs do not sit on the floor. */
export const SPEC_TILT_DB_OCT = 4.5;

const TILT_PIVOT_HZ = 1000;
const LOG_SPAN = Math.log(F_MAX / F_MIN);
const PLOT_INSET = Object.freeze({ top: 6, right: 28, bottom: 22 });
const HIT_RADIUS_PX = 10;
const FINE_DRAG = 0.2;
const WHEEL_STEPS_PER_OCTAVE = 500;
const FINE_WHEEL_STEPS_PER_OCTAVE = 2000;
const BELL_Q = 1;
const NEW_CUT_SLOPE = 24;
const PLAIN_SLOPE = 12;
const SOLO_Q = Object.freeze({ min: 0.4, max: 12, wide: 0.9 });
const HISTORY_LIMIT = 100;
const CURVE_STEP_PX = 2;
const ZERO_DB_DISPLAY = 0.05;
const MINUS_SIGN = "−";

/** Where a click on empty space adds which band. */
const NEW_BAND_EDGES = Object.freeze({ lowcutBelow: 30, lowshelfBelow: 90, highcutAbove: 15000, highshelfAbove: 9000 });

const KEY_STEPS = Object.freeze({
  semitone: 1 / 12, fineSemitone: 1 / 48,
  gainDb: 0.5, fineGainDb: 0.1,
  qOctave: 1 / 4, fineQOctave: 1 / 12,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

const GAIN_TYPES = new Set(["bell", "lowshelf", "highshelf", "tilt"]);
const Q_TYPES = new Set(["bell", "notch", "bandpass", "lowcut", "highcut"]);
const CUT_TYPES = new Set(["lowcut", "highcut"]);
const WIDTH_TYPES = new Set(["bell", "notch", "bandpass"]);

export const hasGain = (type) => GAIN_TYPES.has(type);
export const hasQ = (type) => Q_TYPES.has(type);
export const hasSlope = (type) => CUT_TYPES.has(type);

const startQ = (type) => (type === "bell" ? BELL_Q : EQ_DEFAULT_Q);

/** The plot area inside a canvas of w x h CSS px, room right and below for labels. */
export function plotRect(w, h) {
  return {
    x: 0,
    y: PLOT_INSET.top,
    w: Math.max(1, w - PLOT_INSET.right),
    h: Math.max(1, h - PLOT_INSET.bottom),
  };
}

export function freqToX(f, r) {
  return r.x + (r.w * Math.log(clamp(f, F_MIN, F_MAX) / F_MIN)) / LOG_SPAN;
}

export function xToFreq(x, r) {
  return clamp(F_MIN * Math.exp(((x - r.x) / r.w) * LOG_SPAN), F_MIN, F_MAX);
}

export function dbToY(db, r, range = DB_RANGE) {
  return r.y + r.h / 2 - (db / range) * (r.h / 2);
}

export function yToDb(y, r, range = DB_RANGE) {
  return ((r.y + r.h / 2 - y) / (r.h / 2)) * range;
}

/** A band's handle: at its gain, or on the 0 dB line when it has none. */
export function nodeXY(band, r, range = DB_RANGE) {
  const g = hasGain(band.type) ? clamp(band.g, -range, range) : 0;
  return { x: freqToX(band.f, r), y: dbToY(g, r, range) };
}

/** The band under a point, or -1; the nearest within `radius`, later bands on ties. */
export function hitTest(bands, px, py, r, range = DB_RANGE, radius = HIT_RADIUS_PX) {
  let best = -1;
  let bestD = radius * radius;
  bands.forEach((band, i) => {
    const { x, y } = nodeXY(band, r, range);
    const d = (x - px) ** 2 + (y - py) ** 2;
    if (d <= bestD) { best = i; bestD = d; }
  });
  return best;
}

/** A band dragged by (dx, dy) px from its start; `fine` moves a fifth as far. */
export function dragBand(start, dx, dy, r, { range = DB_RANGE, fine = false } = {}) {
  const k = fine ? FINE_DRAG : 1;
  const out = { ...start, f: round1(xToFreq(freqToX(start.f, r) + dx * k, r)) };
  if (hasGain(start.type)) {
    const y = dbToY(start.g, r, range) + dy * k;
    out.g = round2(clamp(yToDb(y, r, range), -range, range));
  }
  return out;
}

/** Q after a wheel turn: up narrows, multiplicatively; `fine` is a quarter as fast. */
export function wheelQ(q, deltaY, fine = false) {
  const per = fine ? FINE_WHEEL_STEPS_PER_OCTAVE : WHEEL_STEPS_PER_OCTAVE;
  return round3(clamp(q * 2 ** (-deltaY / per), EQ_LIMITS.qMin, EQ_LIMITS.qMax));
}

function newBandType(f) {
  const e = NEW_BAND_EDGES;
  if (f < e.lowcutBelow) return "lowcut";
  if (f < e.lowshelfBelow) return "lowshelf";
  if (f > e.highcutAbove) return "highcut";
  if (f > e.highshelfAbove) return "highshelf";
  return "bell";
}

/** The band a click on empty space adds, by where it lands. */
export function defaultBandAt(f, g) {
  const type = newBandType(f);
  return normalizeBand({
    on: true,
    type,
    f,
    g: hasGain(type) ? g : 0,
    q: startQ(type),
    slope: hasSlope(type) ? NEW_CUT_SLOPE : PLAIN_SLOPE,
  });
}

/** A band put back to its neutral starting point, frequency kept. */
export function resetBand(band) {
  return normalizeBand({ ...band, g: 0, q: startQ(band.type) });
}

/** A band with another type: the frequency stays, the rest takes that type's defaults. */
export function retypeBand(band, type) {
  const keepQ = hasQ(band.type) && hasQ(type) && !hasSlope(type) && !hasSlope(band.type);
  const keepSlope = hasSlope(type) && hasSlope(band.type);
  return normalizeBand({
    ...band,
    type,
    g: hasGain(type) ? band.g : 0,
    q: keepQ ? band.q : startQ(type),
    slope: hasSlope(type) ? (keepSlope ? band.slope : NEW_CUT_SLOPE) : PLAIN_SLOPE,
  });
}

/** What soloing a band plays: a band pass as wide as the band (cuts and shelves: about an octave). */
export function soloEq(band) {
  const q = WIDTH_TYPES.has(band.type) ? clamp(band.q, SOLO_Q.min, SOLO_Q.max) : SOLO_Q.wide;
  const bands = [{ on: true, type: "bandpass", f: band.f, g: 0, q, slope: PLAIN_SLOPE }];
  return { id: "eq", v: EQ_VERSION, bypass: false, params: { out: 0, bands } };
}

function steppedBand(band, key, fine) {
  const s = KEY_STEPS;
  const b = { ...band };
  const semitone = fine ? s.fineSemitone : s.semitone;
  const gain = hasGain(band.type) ? (fine ? s.fineGainDb : s.gainDb) : 0;
  const qStep = 2 ** (fine ? s.fineQOctave : s.qOctave);
  const moves = {
    ArrowLeft: () => { b.f = band.f / 2 ** semitone; },
    ArrowRight: () => { b.f = band.f * 2 ** semitone; },
    ArrowUp: () => { b.g = band.g + gain; },
    ArrowDown: () => { b.g = band.g - gain; },
    PageUp: () => { b.q = band.q * qStep; },
    PageDown: () => { b.q = band.q / qStep; },
  };
  if (!Object.hasOwn(moves, key)) return null;
  moves[key]();
  return b;
}

/** One key press on a focused handle (`fine`: Shift). Returns the new band. */
export function keyStep(band, key, fine = false) {
  const b = steppedBand(band, key, fine);
  if (!b) return band;
  b.f = clamp(b.f, EQ_LIMITS.freqMin, EQ_LIMITS.freqMax);
  return normalizeBand(b);
}

function trimZeros(s) {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** "62.5 Hz", "440 Hz", "1.25 kHz", "12.5 kHz". */
export function fmtFreq(f) {
  if (!Number.isFinite(f)) return "";
  if (f >= 1000) return `${trimZeros((f / 1000).toFixed(f >= 10000 ? 1 : 2))} kHz`;
  return `${trimZeros(f.toFixed(f < 100 ? 1 : 0))} Hz`;
}

/** "+3.5 dB", "-12.0 dB" (typographic minus), "0.0 dB". */
export function fmtDb(g) {
  if (!Number.isFinite(g)) return "";
  const v = Math.abs(g) < ZERO_DB_DISPLAY ? 0 : g;
  const sign = v > 0 ? "+" : v < 0 ? MINUS_SIGN : "";
  return `${sign}${Math.abs(v).toFixed(1)} dB`;
}

/** "0.71", "4.0", "12". */
export function fmtQ(q) {
  if (!Number.isFinite(q)) return "";
  if (q >= 10) return q.toFixed(0);
  return q >= 1 ? q.toFixed(1) : q.toFixed(2);
}

/** A typed number: "1,5" and "1.5" both work; a minus may be typographic. */
export function parseNumber(text) {
  if (typeof text !== "string") return NaN;
  const s = text.trim().replaceAll(MINUS_SIGN, "-").replace(",", ".").replace(/[^0-9.+-]/g, "");
  if (!s || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  return Number(s);
}

/** A typed frequency: "1200", "1.2k", "1,2 kHz", "80 Hz". NaN when it is none. */
export function parseFreq(text) {
  if (typeof text !== "string") return NaN;
  const kilo = /k/i.test(text);
  const n = parseNumber(text.replace(/hz/i, "").replace(/k/i, ""));
  if (!Number.isFinite(n)) return NaN;
  return kilo ? n * 1000 : n;
}

/**
 * Undo history of whole EQ descriptors: push() records the state before a
 * change, undo(current)/redo(current) return the state to go to.
 */
export function createHistory(limit = HISTORY_LIMIT) {
  let past = [];
  let future = [];
  const copy = (d) => JSON.parse(JSON.stringify(d));
  return {
    push(state) {
      if (past.length && JSON.stringify(past.at(-1)) === JSON.stringify(state)) return;
      past = [...past, copy(state)].slice(-limit);
      future = [];
    },
    undo(current) {
      if (!past.length) return null;
      future.push(copy(current));
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      past.push(copy(current));
      return future.pop();
    },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    clear() { past = []; future = []; },
  };
}

/**
 * For each pixel column of the plot, the FFT bins it covers (lo..hi) and the
 * display tilt at its frequency. Built once per size.
 */
export function columnBins(columns, binCount, sampleRate, r, tiltDbOct = 0) {
  const lo = new Int32Array(columns);
  const hi = new Int32Array(columns);
  const tilt = new Float32Array(columns);
  const binHz = sampleRate / 2 / binCount;
  for (let c = 0; c < columns; c++) {
    const f0 = xToFreq(r.x + (c / columns) * r.w, r);
    const f1 = xToFreq(r.x + ((c + 1) / columns) * r.w, r);
    lo[c] = clamp(Math.round(f0 / binHz), 1, binCount - 1);
    hi[c] = clamp(Math.round(f1 / binHz) - 1, lo[c], binCount - 1);
    tilt[c] = tiltDbOct * Math.log2(Math.sqrt(f0 * f1) / TILT_PIVOT_HZ);
  }
  return { lo, hi, tilt };
}

/** One spectrum frame into `out` (dB per column): up at once, down at most `fall` dB. */
export function spectrumFrame(bins, data, out, fall) {
  const { lo, hi, tilt } = bins;
  for (let c = 0; c < out.length; c++) {
    let m = -Infinity;
    for (let i = lo[c]; i <= hi[c]; i++) m = Math.max(m, data[i]);
    m += tilt[c];
    if (!(m > SPEC_MIN_DB)) m = SPEC_MIN_DB;
    out[c] = m >= out[c] ? m : Math.max(m, out[c] - fall);
  }
  return out;
}

/** Log-spaced frequencies across the graph, one per `step` px. */
export function curveFreqs(r, step = CURVE_STEP_PX) {
  const n = Math.max(2, Math.ceil(r.w / step) + 1);
  return Float64Array.from({ length: n }, (_, i) => xToFreq(r.x + (i / (n - 1)) * r.w, r));
}

/** Grid lines: [frequency, label?]. */
export const GRID_FREQS = Object.freeze([
  [20, "20"], [30], [40], [50, "50"], [60], [70], [80], [90],
  [100, "100"], [200, "200"], [300], [400], [500, "500"], [600], [700], [800], [900],
  [1000, "1k"], [2000, "2k"], [3000], [4000], [5000, "5k"], [6000], [7000], [8000], [9000],
  [10000, "10k"], [20000, "20k"],
]);

const COARSE_GRID_ABOVE_DB = 12;
const COARSE_GRID_DB = 6;
const FINE_GRID_DB = 3;

/** dB grid steps for a range. */
export function gridDbs(range = DB_RANGE) {
  const step = range > COARSE_GRID_ABOVE_DB ? COARSE_GRID_DB : FINE_GRID_DB;
  const count = Math.floor((2 * range) / step + 1e-9) + 1;
  return Array.from({ length: count }, (_, i) => -range + i * step);
}
