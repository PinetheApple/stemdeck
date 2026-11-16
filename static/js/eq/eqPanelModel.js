import { clamp, finiteOr, roundTo } from "../audioMath.js";
import { EQ_ID, EQ_VERSION, eqIsFlat, eqResponseDb, normalizeEq } from "../eqMath.js";
import { PANEL_KIND } from "./eqPanelKinds.js";
import { F_MAX, F_MIN, fmtDb, fmtFreq, fmtQ, hasQ, hasSlope } from "./eqGraphMath.js";
import { KEYS, PEDAL_GAIN, SHELF_GAIN, controlsFromEq, panelEq } from "./eqPedalMath.js";

export const MARK_STATE = Object.freeze({ flat: "flat", active: "active", bypassed: "bypassed" });

const MARK_RANGE_DB = 8;
const MARK_STEPS = 24;
const MARK_DIGITS = 1;

/** A lane mark's look: flat (dim), active (coral) or bypassed (settings kept, not heard). */
export function markState(eq) {
  if (!eq?.bypass) return eqIsFlat(eq) ? MARK_STATE.flat : MARK_STATE.active;
  return eqIsFlat({ ...eq, bypass: false }) ? MARK_STATE.flat : MARK_STATE.bypassed;
}

/** An SVG path of the EQ's curve in a w x h box, drawn even while bypassed. */
export function markPath(eq, { w, h }) {
  const shown = eq ? { ...eq, bypass: false } : null;
  const freqs = Array.from({ length: MARK_STEPS + 1 }, (_, i) => F_MIN * (F_MAX / F_MIN) ** (i / MARK_STEPS));
  const db = eqResponseDb(shown, freqs);
  return freqs.map((_, i) => {
    const x = roundTo((i / MARK_STEPS) * w, MARK_DIGITS);
    const y = roundTo(h / 2 - (clamp(db[i], -MARK_RANGE_DB, MARK_RANGE_DB) / MARK_RANGE_DB) * (h / 2), MARK_DIGITS);
    return `${i ? "L" : "M"}${x},${y}`;
  }).join("");
}

/** Where a flat graph starts: four bands at 0 dB, ready to drag. */
export const STARTER_BANDS = Object.freeze([
  Object.freeze({ on: true, type: "lowshelf", f: 90, g: 0, q: 0.707, slope: 12 }),
  Object.freeze({ on: true, type: "bell", f: 400, g: 0, q: 1, slope: 12 }),
  Object.freeze({ on: true, type: "bell", f: 2500, g: 0, q: 1, slope: 12 }),
  Object.freeze({ on: true, type: "highshelf", f: 9000, g: 0, q: 0.707, slope: 12 }),
]);

/** The bands a graph panel edits: the lane's own, or the starter bands when it has none. */
export function graphBands(eq) {
  const bands = eq?.params?.bands?.length ? eq.params.bands : STARTER_BANDS;
  return bands.map((band) => ({ ...band }));
}

const TITLE_KEYS = Object.freeze({
  [PANEL_KIND.graph]: "eq.title",
  [PANEL_KIND.drum]: "eq.parametric",
  [PANEL_KIND.bass]: "eq.bassEq",
  [PANEL_KIND.guitar]: "eq.guitarEq",
  [PANEL_KIND.keys]: "eq.keysEq",
});

export function panelTitleKey(kind) {
  return TITLE_KEYS[kind] || TITLE_KEYS[PANEL_KIND.graph];
}

export const PEDAL_PANEL_KINDS = new Set([PANEL_KIND.bass, PANEL_KIND.guitar, PANEL_KIND.keys]);
export const KNOB_IDS = Object.freeze(["low", "mid", "high", "presence"]);

const STRING_PEDAL_KNOBS = Object.freeze([
  { id: "low", key: "lg", range: PEDAL_GAIN },
  { id: "mid", key: "mg", range: PEDAL_GAIN },
  { id: "high", key: "hg", range: PEDAL_GAIN },
  { id: "presence", key: "hs", range: SHELF_GAIN },
]);
const KNOBS_BY_KIND = Object.freeze({
  [PANEL_KIND.bass]: STRING_PEDAL_KNOBS,
  [PANEL_KIND.guitar]: STRING_PEDAL_KNOBS,
  [PANEL_KIND.keys]: Object.freeze([
    { id: "low", key: "body", range: KEYS.body.range },
    { id: "mid", key: "warmth", range: KEYS.warmth.range },
    { id: "high", key: "air", range: KEYS.air.range },
    { id: "presence", key: "presence", range: KEYS.presence.range },
  ]),
});

const SLOT_CONTROLS = Object.freeze({
  hpf: { f: "hpf" },
  ls: { g: "ls" },
  low: { f: "lf", g: "lg", q: "lq" },
  mid: { f: "mf", g: "mg", q: "mq" },
  high: { f: "hf", g: "hg", q: "hq" },
  hs: { g: "hs" },
  lowcut: { f: "lowcut" },
  body: { g: "body" },
  warmth: { g: "warmth" },
  presence: { f: "presF", g: "presence" },
  air: { g: "air" },
  tone: { g: "tone" },
});

/** The four knobs of a pedal panel: [{id, key, min, max}]. */
export function pedalKnobs(kind) {
  return (KNOBS_BY_KIND[kind] || []).map(({ id, key, range }) => ({ id, key, min: -range, max: range }));
}

function knobSpec(kind, id) {
  return pedalKnobs(kind).find((k) => k.id === id);
}

export function knobValue(kind, eq, id) {
  return controlsFromEq(kind, eq)[knobSpec(kind, id).key];
}

/** The lane's EQ with one knob turned; bypass and the other controls kept. */
export function eqWithKnob(kind, eq, id, value) {
  const spec = knobSpec(kind, id);
  const controls = { ...controlsFromEq(kind, eq), [spec.key]: clamp(finiteOr(value, 0), spec.min, spec.max) };
  return panelEq(kind, controls, { bypass: eq?.bypass === true });
}

const KNOB_SWEEP_DEG = 270;
export const KNOB_SWEEP_HALF_DEG = KNOB_SWEEP_DEG / 2;
const KNOB_PX_PER_RANGE = 120;
const KNOB_FINE = 0.25;
const KNOB_STEPS_PER_DB = 2;

/** Degrees from straight up: 0 at noon, half the sweep at either end. */
export function knobAngle(value, min, max) {
  const mid = (min + max) / 2;
  return ((clamp(value, min, max) - mid) / (max - mid)) * KNOB_SWEEP_HALF_DEG;
}

/** A knob's value after a vertical drag of dy px (up is negative), on half dB steps. */
export function knobDragValue(start, dy, min, max, fine = false) {
  const perPx = ((max - min) / KNOB_PX_PER_RANGE) * (fine ? KNOB_FINE : 1);
  const raw = clamp(start - dy * perPx, min, max);
  return Math.round(raw * KNOB_STEPS_PER_DB) / KNOB_STEPS_PER_DB;
}

export const KNOB_KEY_STEP_DB = 1 / KNOB_STEPS_PER_DB;

const SLOPE_UNIT = "dB/oct";
const Q_PREFIX = "Q";

/** The selected band's readout: {typeKey, f, g, q} as display text. */
export function readoutParts(band) {
  return {
    typeKey: `eq.type.${band.type}`,
    f: fmtFreq(band.f),
    g: hasSlope(band.type) ? `${band.slope} ${SLOPE_UNIT}` : fmtDb(band.g),
    q: hasQ(band.type) && !hasSlope(band.type) ? `${Q_PREFIX} ${fmtQ(band.q)}` : "",
  };
}

const SUGGEST_MODE = "replace";

export function suggestEqUrl(jobId, lane, kind) {
  const q = new URLSearchParams({ lane, layout: kind, mode: SUGGEST_MODE });
  return `/api/jobs/${jobId}/suggest/eq?${q}`;
}

const MODE_PARAM = "mode";

/** The master Suggest for a mix source {jobId, query}: the loudness readout's own mix query. */
export function suggestMasterUrl({ jobId, query }) {
  const q = new URLSearchParams(query);
  q.set(MODE_PARAM, SUGGEST_MODE);
  return `/api/jobs/${jobId}/suggest/master?${q}`;
}

const suggestedBands = (body) => (Array.isArray(body?.bands) ? body.bands : []);

/** A pedal's controls from a suggested answer: each band sets the controls of its slot. */
export function controlsFromSuggestion(kind, body) {
  const controls = controlsFromEq(kind, null);
  for (const band of suggestedBands(body)) {
    const keys = SLOT_CONTROLS[band?.slot];
    if (!keys) continue;
    for (const [field, key] of Object.entries(keys)) {
      if (key in controls && Number.isFinite(band[field])) controls[key] = band[field];
    }
  }
  controls.lvl = finiteOr(body?.out, 0);
  return controls;
}

const CURVE_POINT_LENGTH = 2;
const isCurvePoint = (p) => Array.isArray(p) && p.length === CURVE_POINT_LENGTH && p.every(Number.isFinite);

/** The target curve of a Suggest answer as [[Hz, dB], ...], or null when it has none. */
export function targetCurvePoints(body) {
  const curve = body?.target_curve;
  if (!Array.isArray(curve)) return null;
  const points = curve.filter(isCurvePoint).map(([f, db]) => [f, db]);
  return points.length ? points : null;
}

/** The EQ descriptor a Suggest answer stands for, in the lane's own panel kind. */
export function eqFromSuggestion(body, kind) {
  if (PEDAL_PANEL_KINDS.has(kind)) return panelEq(kind, controlsFromSuggestion(kind, body));
  const bands = suggestedBands(body).map((band) => ({ ...band, on: true }));
  return normalizeEq({ id: EQ_ID, v: EQ_VERSION, bypass: false, params: { out: body?.out, bands } });
}

/**
 * Suggest's Apply / Undo: show() plays the suggestion unsaved, apply() saves
 * it, undo() plays the saved EQ again (preview(lane, null)).
 */
export function createSuggestSession({ preview, commit }) {
  let pending = null;
  return {
    get active() { return pending !== null; },
    get lane() { return pending?.lane ?? null; },
    get suggested() { return pending?.suggested ?? null; },
    show(lane, suggested) {
      pending = { lane, suggested };
      preview(lane, suggested);
    },
    apply() {
      if (!pending) return;
      const { lane, suggested } = pending;
      pending = null;
      commit(lane, suggested);
    },
    undo() {
      if (!pending) return;
      const { lane } = pending;
      pending = null;
      preview(lane, null);
    },
  };
}
