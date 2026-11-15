// The engine has only RBJ shelves and stops at 20 kHz, so the reference
// pedals' 6 dB/oct shelves and 22 kHz low-pass are approximated.

import { clamp, finiteOr, round1, round2, round3 } from "../audioMath.js";
import {
  EQ_DEFAULT_Q,
  EQ_ID,
  EQ_LIMITS,
  EQ_PLAIN_SLOPE,
  EQ_VERSION,
  normalizeEq,
} from "../eqMath.js";
import { PANEL_KIND } from "./eqPanelKinds.js";

const NOON = 0.5;
const STOP_TOLERANCE_HZ = 0.05;

export function logPos(v, min, max) {
  return clamp(Math.log(clamp(v, min, max) / min) / Math.log(max / min), 0, 1);
}
export function logVal(p, min, max) {
  return min * (max / min) ** clamp(p, 0, 1);
}
export function linPos(v, min, max) {
  return clamp((v - min) / (max - min), 0, 1);
}
export function linVal(p, min, max) {
  return min + clamp(p, 0, 1) * (max - min);
}

// The pedals' Q knob: wide fully left, medium at noon, narrow fully right,
// each half geometric.
export const Q_WIDE = 1;
export const Q_MID = 2.5;
export const Q_NARROW = 4;

export function qVal(p) {
  const x = clamp(p, 0, 1);
  return x <= NOON
    ? Q_WIDE * (Q_MID / Q_WIDE) ** (x / NOON)
    : Q_MID * (Q_NARROW / Q_MID) ** ((x - NOON) / NOON);
}

export function qPos(q) {
  const v = clamp(q, Q_WIDE, Q_NARROW);
  return v <= Q_MID
    ? NOON * (Math.log(v / Q_WIDE) / Math.log(Q_MID / Q_WIDE))
    : NOON + NOON * (Math.log(v / Q_MID) / Math.log(Q_NARROW / Q_MID));
}

export const PEDAL_GAIN = 15;
export const LEVEL_MIN = EQ_LIMITS.outMin;
export const LEVEL_MAX = EQ_LIMITS.outMax;
export const SHELF_GAIN = 15;
const DYNAMIC_SHELF_STILL_DB = 3;

export const PEDALS = Object.freeze({
  bass: Object.freeze({
    low: { min: 35, max: 500 },
    mid: { min: 100, max: 1600 },
    high: { min: 375, max: 9700 },
    hpf: { min: 10, max: 200 },
    lpf: { min: 215, max: 20000 },
    lowShelf: { dynamic: true, fMin: 75, fMax: 400, f: 75 },
    highShelf: { f: 1000 },
  }),
  guitar: Object.freeze({
    low: { min: 35, max: 500 },
    mid: { min: 250, max: 5000 },
    high: { min: 1000, max: 20000 },
    hpf: { min: 10, max: 330 },
    lpf: { min: 1500, max: 20000 },
    lowShelf: { f: 200 },
    highShelf: { f: 1000 },
  }),
});

const geo = (range) => Math.sqrt(range.min * range.max);

/** Every control at its starting point: frequencies at noon, flat, filters open. */
export function pedalDefaults(kind) {
  const p = PEDALS[kind];
  return {
    lf: round1(geo(p.low)), lg: 0, lq: Q_MID,
    mf: round1(geo(p.mid)), mg: 0, mq: Q_MID,
    hf: round1(geo(p.high)), hg: 0, hq: Q_MID,
    hpf: p.hpf.min, lpf: p.lpf.max,
    ls: 0, hs: 0, lvl: 0,
  };
}

/** Control values made safe: numbers clamped into each control's range. */
export function normalizePedal(kind, raw) {
  const p = PEDALS[kind];
  const d = pedalDefaults(kind);
  const c = raw && typeof raw === "object" ? raw : {};
  const gain = (v) => round2(clamp(finiteOr(v, 0), -PEDAL_GAIN, PEDAL_GAIN));
  const q = (v) => round3(clamp(finiteOr(v, Q_MID), Q_WIDE, Q_NARROW));
  const freq = (v, fallback, range) => round1(clamp(finiteOr(v, fallback), range.min, range.max));
  const shelf = (v) => round2(clamp(finiteOr(v, 0), -SHELF_GAIN, SHELF_GAIN));
  return {
    lf: freq(c.lf, d.lf, p.low),
    lg: gain(c.lg),
    lq: q(c.lq),
    mf: freq(c.mf, d.mf, p.mid),
    mg: gain(c.mg),
    mq: q(c.mq),
    hf: freq(c.hf, d.hf, p.high),
    hg: gain(c.hg),
    hq: q(c.hq),
    hpf: freq(c.hpf, d.hpf, p.hpf),
    lpf: freq(c.lpf, d.lpf, p.lpf),
    ls: shelf(c.ls),
    hs: shelf(c.hs),
    lvl: round2(clamp(finiteOr(c.lvl, 0), LEVEL_MIN, LEVEL_MAX)),
  };
}

/**
 * The bass pedal's low shelf frequency for a shelf gain: fMin for a little
 * boost or cut, moving geometrically up to fMax at full gain.
 */
export function dynamicShelfFreq(g, fMin = PEDALS.bass.lowShelf.fMin, fMax = PEDALS.bass.lowShelf.fMax) {
  const a = Math.abs(g);
  if (a <= DYNAMIC_SHELF_STILL_DB) return fMin;
  const travel = (Math.min(a, SHELF_GAIN) - DYNAMIC_SHELF_STILL_DB) / (SHELF_GAIN - DYNAMIC_SHELF_STILL_DB);
  return round1(fMin * (fMax / fMin) ** travel);
}

/** A high-pass at its stop, or a low-pass at its top, is off. */
export const hpfOn = (kind, hz) => hz > PEDALS[kind].hpf.min + STOP_TOLERANCE_HZ;
export const lpfOn = (kind, hz) => hz < PEDALS[kind].lpf.max - STOP_TOLERANCE_HZ;

const band = (on, type, f, g = 0, q = EQ_DEFAULT_Q) => ({ on, type, f, g, q, slope: EQ_PLAIN_SLOPE });

function eqFrom(bands, out, bypass, ui) {
  return normalizeEq({ id: EQ_ID, v: EQ_VERSION, bypass, params: { out, bands, ui } });
}

/**
 * A pedal's EQ: seven bands in fixed places, so turning a knob never
 * reorders the engine's filters. A band at 0 dB or a filter at its stop runs
 * no filter.
 */
export function pedalEq(kind, controls, { bypass = false, ui = {} } = {}) {
  const p = PEDALS[kind];
  const c = normalizePedal(kind, controls);
  const lowShelfF = p.lowShelf.dynamic ? dynamicShelfFreq(c.ls, p.lowShelf.fMin, p.lowShelf.fMax) : p.lowShelf.f;
  const bands = [
    band(hpfOn(kind, c.hpf), "lowcut", c.hpf),
    band(true, "lowshelf", lowShelfF, c.ls),
    band(true, "bell", c.lf, c.lg, c.lq),
    band(true, "bell", c.mf, c.mg, c.mq),
    band(true, "bell", c.hf, c.hg, c.hq),
    band(true, "highshelf", p.highShelf.f, c.hs),
    band(lpfOn(kind, c.lpf), "highcut", c.lpf),
  ];
  return eqFrom(bands, c.lvl, bypass, { ...ui, panel: kind, c });
}

export const KEYS = Object.freeze({
  body: { f: 120, range: 12 },
  warmth: { f: 250, q: 0.8, range: 12 },
  presence: { min: 2000, max: 5000, q: 1, range: 12, f: 3000 },
  air: { f: 10000, range: 12 },
  tone: { f: 1000, range: 6 },
  lowcut: { min: 20, max: 300 },
  level: { min: -12, max: 12 },
});
const KEYS_PANEL = PANEL_KIND.keys;

export function keysDefaults() {
  return {
    body: 0, warmth: 0, presence: 0, presF: KEYS.presence.f, air: 0, tone: 0, lowcut: KEYS.lowcut.min, lvl: 0,
  };
}

export function normalizeKeys(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const gain = (v, range) => round2(clamp(finiteOr(v, 0), -range, range));
  return {
    body: gain(c.body, KEYS.body.range),
    warmth: gain(c.warmth, KEYS.warmth.range),
    presence: gain(c.presence, KEYS.presence.range),
    presF: round1(clamp(finiteOr(c.presF, KEYS.presence.f), KEYS.presence.min, KEYS.presence.max)),
    air: gain(c.air, KEYS.air.range),
    tone: gain(c.tone, KEYS.tone.range),
    lowcut: round1(clamp(finiteOr(c.lowcut, KEYS.lowcut.min), KEYS.lowcut.min, KEYS.lowcut.max)),
    lvl: round2(clamp(finiteOr(c.lvl, 0), KEYS.level.min, KEYS.level.max)),
  };
}

/** The Keys EQ: low cut, body, warmth, presence, air and tone, with the level as output gain. */
export function keysEq(controls, { bypass = false, ui = {} } = {}) {
  const c = normalizeKeys(controls);
  const bands = [
    band(c.lowcut > KEYS.lowcut.min + STOP_TOLERANCE_HZ, "lowcut", c.lowcut),
    band(true, "lowshelf", KEYS.body.f, c.body),
    band(true, "bell", KEYS.warmth.f, c.warmth, KEYS.warmth.q),
    band(true, "bell", c.presF, c.presence, KEYS.presence.q),
    band(true, "highshelf", KEYS.air.f, c.air),
    band(true, "tilt", KEYS.tone.f, c.tone),
  ];
  return eqFrom(bands, c.lvl, bypass, { ...ui, panel: KEYS_PANEL, c });
}

/** The controls a panel shows for a saved EQ: its own save, else the starting point. */
export function controlsFromEq(kind, eq) {
  const ui = eq?.params?.ui;
  const mine = ui && ui.panel === kind && ui.c && typeof ui.c === "object" ? ui.c : null;
  if (kind === KEYS_PANEL) return normalizeKeys(mine || keysDefaults());
  return normalizePedal(kind, mine || pedalDefaults(kind));
}

/** A panel's descriptor from its controls (pedal or keys). */
export function panelEq(kind, controls, opts) {
  return kind === KEYS_PANEL ? keysEq(controls, opts) : pedalEq(kind, controls, opts);
}
