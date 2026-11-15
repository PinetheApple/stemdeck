// The EQ surface the panels and the exports talk to. The descriptors live in
// the mix (mixer.js stores, saves and plays them); this module adds what the
// panels need on top: A/B and solo previews that are never saved, response
// curves at the live rate, spectrum taps, and the export `fx=` parameter.

import { audioEngine, mixerState } from "./state.js";
import { MASTER_LANE } from "./mixFx.js";
import { getLaneEq, playLaneEq, setLaneEq } from "./mixer.js";
import { encodeFxParam, eqIsFlat, eqResponseDb, flatEq, normalizeEq } from "./eqMath.js";

export { MASTER_LANE } from "./mixFx.js";
export { applyAllFx, getLaneEq, onFxChange, setLaneEq } from "./mixer.js";

const DEFAULT_RATE = 44100;
const PRE = "pre";
const POST = "post";

const tapSide = (which) => (which === PRE ? PRE : POST);
const isKnownLane = (lane) => lane === MASTER_LANE || !!mixerState[lane];

/** Bypass (A/B) a lane's EQ without losing its settings. Saved. */
export function setBypass(lane, on) {
  const eq = getLaneEq(lane);
  eq.bypass = !!on;
  return setLaneEq(lane, eq);
}

/** Back to flat: no bands, 0 dB output, panel state cleared. */
export function resetLane(lane) {
  return setLaneEq(lane, flatEq());
}

/**
 * Play another EQ on the lane without saving or announcing it (an A/B
 * compare, a soloed band); null goes back to the saved EQ.
 */
export function previewLaneEq(lane, descriptor) {
  if (!isKnownLane(lane)) return null;
  const eq = descriptor === null ? getLaneEq(lane) : normalizeEq(descriptor);
  playLaneEq(lane, eq);
  return eq;
}

/** True when the lane's EQ changes the sound. */
export function isLaneActive(lane) {
  return !eqIsFlat(getLaneEq(lane));
}

/** The rate the live EQ runs at (44.1 kHz when no engine is up). */
export function liveSampleRate() {
  return audioEngine?.audioContext?.sampleRate || DEFAULT_RATE;
}

/** The lane's EQ response in dB at `freqs`, from the descriptor, at the live rate. */
export function getFrequencyResponse(lane, freqs, { sampleRate } = {}) {
  return Float32Array.from(eqResponseDb(getLaneEq(lane), freqs, sampleRate || liveSampleRate()));
}

/** The response read back from the engine's own filters, or null without an engine. */
export function getNodeResponse(lane, freqs) {
  if (!audioEngine?.supportsEq) return null;
  const db = lane === MASTER_LANE
    ? audioEngine.getMasterNodeResponseDb(freqs)
    : audioEngine.getLaneNodeResponseDb(lane, freqs);
  return db ? Float32Array.from(db) : null;
}

/**
 * An AnalyserNode on the lane before ("pre") or after ("post") its EQ, for a
 * spectrum; release it when the display closes. Ask again after a song load.
 */
export function getAnalyser(lane, which = POST, opts) {
  if (!audioEngine?.supportsEq) return null;
  const side = tapSide(which);
  return lane === MASTER_LANE ? audioEngine.getMasterTap(side, opts) : audioEngine.getLaneTap(lane, side, opts);
}

export function releaseAnalyser(lane, which = POST) {
  if (!audioEngine?.supportsEq) return;
  const side = tapSide(which);
  if (lane === MASTER_LANE) audioEngine.releaseMasterTap(side);
  else audioEngine.releaseLaneTap(lane, side);
}

/** The export `fx=` value for these lanes and the master EQ, "" when nothing changes. */
export function exportFxParam(laneNames) {
  const lanes = Object.fromEntries((laneNames || []).map((name) => [name, getLaneEq(name)]));
  return encodeFxParam(lanes, getLaneEq(MASTER_LANE));
}
