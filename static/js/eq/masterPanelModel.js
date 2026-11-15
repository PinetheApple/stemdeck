import { clamp, roundTo } from "../audioMath.js";
import {
  LOSSY_CEILING_DBTP,
  MASTER_ID,
  MASTER_LIMITS,
  MASTER_VERSION,
  MASTER_PRESETS,
  applyPreset,
  isLossyFormat,
  masterIsOn,
  normalizeMaster,
} from "../masterMath.js";

export const LOUDNESS_CHOICE = Object.freeze({ streaming: "streaming", loud: "loud", off: "off" });

const PRESET = Object.freeze(Object.fromEntries(Object.keys(MASTER_PRESETS).map((key) => [key, key])));
const PRESET_BY_CHOICE = Object.freeze({
  [LOUDNESS_CHOICE.streaming]: PRESET.streaming,
  [LOUDNESS_CHOICE.loud]: PRESET.louder,
  [LOUDNESS_CHOICE.off]: null,
});

/** Which of Streaming / Loud / Off the master reads as; null for another target. */
export function loudnessChoice(master) {
  if (!masterIsOn(master)) return LOUDNESS_CHOICE.off;
  const target = master.params.target_lufs;
  if (target === MASTER_PRESETS[PRESET.streaming].target) return LOUDNESS_CHOICE.streaming;
  if (target === MASTER_PRESETS[PRESET.louder].target) return LOUDNESS_CHOICE.loud;
  return null;
}

/** The masterMath preset a choice picks; null means mastering off. */
export function choosePresetFor(choice) {
  return PRESET_BY_CHOICE[choice] ?? null;
}

/** The master descriptor a Suggest answer's `master` stands for, switched on. */
export function masterFromSuggestion(body) {
  return normalizeMaster({ id: MASTER_ID, v: MASTER_VERSION, bypass: false, params: body?.master });
}

const CEILING_STEP_DB = 0.1;
const CEILING_DIGITS = 1;

/** The master with its ceiling moved by `steps` tenths of a dB, as a custom preset. */
export function stepCeiling(master, steps) {
  const current = normalizeMaster(master);
  const ceiling = roundTo(
    clamp(current.params.ceiling_dbtp + steps * CEILING_STEP_DB, MASTER_LIMITS.ceilingMin, MASTER_LIMITS.ceilingMax),
    CEILING_DIGITS,
  );
  const custom = applyPreset(current, PRESET.custom);
  return normalizeMaster({ ...custom, params: { ...custom.params, ceiling_dbtp: ceiling } });
}

const MINUS = "−";
const NONE = "—";
const WAITING = "…";
const LOUDNESS_DIGITS = 1;
const DEFAULT_UNITS = Object.freeze({ lufs: "LUFS", dbtp: "dBTP" });
export const PERCENT = 100;
const PERCENT_SIGN = "%";
const LABEL_JOIN = " · ";
const MEASURING = "measuring";

/** "−14", "−1.5", "+3.2" (plus only when asked), trailing ".0" dropped when `trim`. */
export function fmtSigned(v, { digits = LOUDNESS_DIGITS, plus = false, trim = false } = {}) {
  if (!Number.isFinite(v)) return NONE;
  let text = Math.abs(v).toFixed(digits);
  if (trim) text = String(Number(text));
  const sign = v < 0 && Number(text) !== 0 ? MINUS : (plus && v > 0 ? "+" : "");
  return `${sign}${text}`;
}

function measured(planState, value, opts) {
  if (planState === MEASURING) return WAITING;
  return fmtSigned(value, opts);
}

/** The Export loudness numbers: target, ceiling, loudness now and the gain applied at export. */
export function loudnessReadout(master, plan, planState) {
  const m = normalizeMaster(master);
  const on = masterIsOn(m);
  const target = m.params.target_lufs;
  return {
    target: on && target !== null ? fmtSigned(target, { trim: true }) : NONE,
    ceiling: fmtSigned(m.params.ceiling_dbtp),
    now: on ? measured(planState, plan?.pre?.i) : NONE,
    gain: on ? measured(planState, plan?.gain_db, { plus: true }) : NONE,
  };
}

/** "35%" for an amount of 0.35. */
export function fmtPercent(fraction) {
  return `${Math.round(fraction * PERCENT)}${PERCENT_SIGN}`;
}

/** How full the gain reduction bar is for a reduction of `db` (negative) on a `scaleDb` bar. */
export function grFraction(db, scaleDb) {
  if (!Number.isFinite(db)) return 0;
  return clamp(-db / scaleDb, 0, 1);
}

/** The ceiling an export of this format gets: lossy ones never above the lossy cap. */
export function exportCeiling(ceiling, format) {
  return isLossyFormat(format) ? Math.min(ceiling, LOSSY_CEILING_DBTP) : ceiling;
}

/** "−14 LUFS · −1 dBTP" for the export row; just the ceiling when there is no target. */
export function exportMasterLabel(master, format, units = DEFAULT_UNITS) {
  const m = normalizeMaster(master);
  const ceiling = `${fmtSigned(exportCeiling(m.params.ceiling_dbtp, format), { trim: true })} ${units.dbtp}`;
  if (m.params.target_lufs === null) return ceiling;
  return `${fmtSigned(m.params.target_lufs, { trim: true })} ${units.lufs}${LABEL_JOIN}${ceiling}`;
}

/** Add the export's fx= and master= values to a query, each only when it says something. */
export function addExportParams(q, { fx, master }) {
  if (fx) q.set("fx", fx);
  if (master) q.set("master", master);
  return q;
}
