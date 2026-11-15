// Previews and responses here never touch the saved mix; only setLaneEq and
// its wrappers save, so an A/B compare cannot leak into the store or export.

import { audioEngine, mixerState } from "./state.js";
import { TAP_SIDE } from "./fxChain.js";
import { MASTER_LANE, getLaneEq, playLaneEq, setLaneEq } from "./mixFx.js";
import {
  EQ_DEFAULT_RATE,
  encodeFxParam,
  eqIsFlat,
  eqResponseDb,
  flatEq,
  normalizeEq,
} from "./eqMath.js";

export {
  MASTER_LANE,
  applyAllFx,
  getLaneEq,
  onFxChange,
  setLaneEq,
} from "./mixFx.js";

const tapSide = (which) => (which === TAP_SIDE.pre ? TAP_SIDE.pre : TAP_SIDE.post);
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

/** Play another EQ on the lane without saving it; null goes back to the saved EQ. */
export function previewLaneEq(lane, descriptor) {
  if (!isKnownLane(lane)) return null;
  const eq = descriptor === null ? getLaneEq(lane) : normalizeEq(descriptor);
  playLaneEq(lane, eq);
  return eq;
}

export function isLaneActive(lane) {
  return !eqIsFlat(getLaneEq(lane));
}

export function liveSampleRate() {
  return audioEngine?.audioContext?.sampleRate || EQ_DEFAULT_RATE;
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

/** An AnalyserNode before or after the lane's EQ; release it when done, ask again after a song load. */
export function getAnalyser(lane, which = TAP_SIDE.post, opts) {
  if (!audioEngine?.supportsEq) return null;
  const side = tapSide(which);
  return lane === MASTER_LANE ? audioEngine.getMasterTap(side, opts) : audioEngine.getLaneTap(lane, side, opts);
}

export function releaseAnalyser(lane, which = TAP_SIDE.post) {
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
