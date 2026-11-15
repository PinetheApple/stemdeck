// Volume, mute and solo of each recording track, kept per song; a solo on
// either side silences the other, the rule the stems follow among themselves.

import { masterVolume } from "./state.js";
import { storeFlushPending, storeGet, storeSetDebounced } from "./utils.js";
import { LANE_VOLUME_MAX } from "./constants.js";
import { setTakeLaneGain } from "./takesPlayback.js";

const mixKey = (jobId) => `stemdeck:takemix:${jobId}`;
const DEFAULT_ENTRY = Object.freeze({ volume: 1, muted: false, soloed: false });

let jobId = null;
let mix = {};
let trackIds = [];

export async function loadTakeMix(id) {
  jobId = id;
  mix = {};
  try {
    await storeFlushPending(mixKey(id));
    const stored = await storeGet(mixKey(id), {});
    if (jobId === id && stored && typeof stored === "object") mix = stored;
  } catch (err) {
    console.warn("[takes] track mix could not load:", err);
  }
}

export function setMixTracks(ids) {
  trackIds = ids;
}

export function takeMixEntry(trackId) {
  return { ...DEFAULT_ENTRY, ...mix[trackId] };
}

function save(trackId, change) {
  mix[trackId] = { ...takeMixEntry(trackId), ...change };
  if (jobId) storeSetDebounced(mixKey(jobId), mix);
}

export function setTakeVolume(trackId, volume) {
  save(trackId, { volume: Math.max(0, Math.min(LANE_VOLUME_MAX, volume)) });
}

export function toggleTakeMute(trackId) {
  save(trackId, { muted: !takeMixEntry(trackId).muted });
}

export function toggleTakeSolo(trackId) {
  save(trackId, { soloed: !takeMixEntry(trackId).soloed });
}

export function takeSoloActive() {
  return trackIds.some((id) => takeMixEntry(id).soloed);
}

/** The gain a track plays at, given whether any lane at all is soloed. */
export function effectiveTakeGain(entry, anySolo, master) {
  if (entry.muted || (anySolo && !entry.soloed)) return 0;
  return entry.volume * master;
}

/** Push every track's gain into the take player; `anySolo` covers stems and tracks. */
export function applyTakeGains(anySolo) {
  for (const id of trackIds) setTakeLaneGain(id, effectiveTakeGain(takeMixEntry(id), anySolo, masterVolume));
}

