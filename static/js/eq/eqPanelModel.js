import { clamp, roundTo } from "../audioMath.js";
import { EQ_ID, EQ_VERSION, eqIsFlat, eqResponseDb, normalizeEq } from "../eqMath.js";
import { PANEL_KIND } from "./eqPanelKinds.js";
import { F_MAX, F_MIN, fmtDb, fmtFreq, fmtQ, hasQ, hasSlope } from "./eqGraphMath.js";

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
});

export function panelTitleKey(kind) {
  return TITLE_KEYS[kind] || TITLE_KEYS[PANEL_KIND.graph];
}

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

const CURVE_POINT_LENGTH = 2;
const isCurvePoint = (p) => Array.isArray(p) && p.length === CURVE_POINT_LENGTH && p.every(Number.isFinite);

/** The target curve of a Suggest answer as [[Hz, dB], ...], or null when it has none. */
export function targetCurvePoints(body) {
  const curve = body?.target_curve;
  if (!Array.isArray(curve)) return null;
  const points = curve.filter(isCurvePoint).map(([f, db]) => [f, db]);
  return points.length ? points : null;
}

/** The EQ descriptor a Suggest answer stands for, as graph bands. */
export function eqFromSuggestion(body) {
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
