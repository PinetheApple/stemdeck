// What the Master view and the export row show, without the DOM.

import { clamp, roundTo } from "../audioMath.js";
import {
  LOSSY_CEILING_DBTP,
  MASTER_LIMITS,
  MASTER_PRESETS,
  applyPreset,
  masterIsOn,
  normalizeMaster,
} from "../masterMath.js";

export const LOUDNESS_CHOICE = Object.freeze({ streaming: "streaming", loud: "loud", off: "off" });

const PRESET_BY_CHOICE = Object.freeze({
  [LOUDNESS_CHOICE.streaming]: "streaming",
  [LOUDNESS_CHOICE.loud]: "louder",
  [LOUDNESS_CHOICE.off]: null,
});
const CUSTOM_PRESET = "custom";

/** Which of Streaming / Loud / Off the master reads as; null for another target. */
export function loudnessChoice(master) {
  if (!masterIsOn(master)) return LOUDNESS_CHOICE.off;
  const target = master.params.target_lufs;
  if (target === MASTER_PRESETS.streaming.target) return LOUDNESS_CHOICE.streaming;
  if (target === MASTER_PRESETS.louder.target) return LOUDNESS_CHOICE.loud;
  return null;
}

/** The masterMath preset a choice picks; null means mastering off. */
export function choosePresetFor(choice) {
  return PRESET_BY_CHOICE[choice] ?? null;
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
  const custom = applyPreset(current, CUSTOM_PRESET);
  return normalizeMaster({ ...custom, params: { ...custom.params, ceiling_dbtp: ceiling } });
}

const MINUS = "−";
const NONE = "—";
const WAITING = "…";
const LOUDNESS_DIGITS = 1;
const LUFS_UNIT = "LUFS";
const DBTP_UNIT = "dBTP";
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

/** How full the gain reduction bar is for a reduction of `db` (negative) on a `scaleDb` bar. */
export function grFraction(db, scaleDb) {
  if (!Number.isFinite(db)) return 0;
  return clamp(-db / scaleDb, 0, 1);
}

const LOSSY_FORMATS = new Set(["mp3", "ogg", "mp4"]);

/** The ceiling an export of this format gets: lossy ones never above the lossy cap. */
export function exportCeiling(ceiling, format) {
  return LOSSY_FORMATS.has(format) ? Math.min(ceiling, LOSSY_CEILING_DBTP) : ceiling;
}

/** "−14 LUFS · −1 dBTP" for the export row; just the ceiling when there is no target. */
export function exportMasterLabel(master, format) {
  const m = normalizeMaster(master);
  const ceiling = `${fmtSigned(exportCeiling(m.params.ceiling_dbtp, format), { trim: true })} ${DBTP_UNIT}`;
  if (m.params.target_lufs === null) return ceiling;
  return `${fmtSigned(m.params.target_lufs, { trim: true })} ${LUFS_UNIT}${LABEL_JOIN}${ceiling}`;
}

/** Add the export's fx= and master= values to a query, each only when it says something. */
export function addExportParams(q, { fx, master }) {
  if (fx) q.set("fx", fx);
  if (master) q.set("master", master);
  return q;
}
