// Lives beside mixer.js, which binds its save and lane list here, so the EQ
// and master settings travel in the same per-song mix record.

import { audioEngine, mixerState } from "./state.js";
import { EQ_ID, EQ_VERSION, normalizeEq } from "./eqMath.js";
import { MASTER_ID, MASTER_VERSION, normalizeMaster } from "./masterMath.js";

/** The master slot's key in the mix (never a lane name). */
export const MASTER_LANE = "__master";

const EFFECT_ORDER = Object.freeze([EQ_ID, MASTER_ID]);
const listeners = new Set();
let hooks = { save: () => {}, laneNames: () => [] };

export function defaultMasterEntry() {
  return { fx: [] };
}

function findValid(list, id, version) {
  if (!Array.isArray(list)) return null;
  return list.find((d) => d && typeof d === "object" && d.id === id && d.v === version) || null;
}

/** True for an EQ that holds nothing worth storing. */
export function eqIsEmpty(eq) {
  const { out, bands, ui } = eq.params;
  return !eq.bypass && out === 0 && !bands.length && ui === undefined;
}

function storedEq(list) {
  const raw = findValid(list, EQ_ID, EQ_VERSION);
  const eq = raw && normalizeEq(raw);
  return eq && !eqIsEmpty(eq) ? eq : null;
}

/** A lane's stored `fx`: its EQ, normalised, or [] for anything unreadable. */
export function normalizeLaneFx(raw) {
  const eq = storedEq(raw);
  return eq ? [eq] : [];
}

/** The stored master slot: {fx: [EQ?, master?]}, unreadable entries dropped. */
export function normalizeMasterEntry(raw) {
  const list = raw && typeof raw === "object" ? raw.fx : null;
  const master = findValid(list, MASTER_ID, MASTER_VERSION);
  return { fx: [storedEq(list), master && normalizeMaster(master)].filter(Boolean) };
}

function findEffect(list, id) {
  return (Array.isArray(list) ? list : []).find((d) => d?.id === id) || null;
}

function withEffect(list, id, descriptor) {
  const byId = new Map((Array.isArray(list) ? list : []).map((d) => [d?.id, d]));
  if (descriptor) byId.set(id, descriptor);
  else byId.delete(id);
  return EFFECT_ORDER.map((key) => byId.get(key)).filter(Boolean);
}

/** mixer.js hands over how it saves the mix and which lanes it holds. */
export function bindFxStore({ save, laneNames }) {
  hooks = { save, laneNames };
}

export function ensureFxDefaults(names) {
  for (const name of names) if (mixerState[name] && !mixerState[name].fx) mixerState[name].fx = [];
  if (!mixerState[MASTER_LANE]) mixerState[MASTER_LANE] = defaultMasterEntry();
}

/** Replace the lanes' and master's effects with the stored mix's, normalised. */
export function loadFxIntoState(stored, names) {
  for (const name of names) if (mixerState[name]) mixerState[name].fx = normalizeLaneFx(stored?.[name]?.fx);
  mixerState[MASTER_LANE] = normalizeMasterEntry(stored?.[MASTER_LANE]);
}

export function resetFxState(names) {
  loadFxIntoState(null, names);
}

function fxEntry(lane) {
  if (lane === MASTER_LANE && !mixerState[MASTER_LANE]) mixerState[MASTER_LANE] = defaultMasterEntry();
  return mixerState[lane] || null;
}

function emitFxChange(change) {
  for (const listener of listeners) {
    try { listener(change); } catch (e) { console.warn("[mixFx] change listener failed:", e); }
  }
}

/** Play an EQ on a lane (or MASTER_LANE) without storing it. */
export function playLaneEq(lane, eq, opts) {
  if (!audioEngine?.supportsEq) return;
  try {
    if (lane === MASTER_LANE) audioEngine.setMasterEq(eq, opts);
    else audioEngine.setLaneEq(lane, eq, opts);
  } catch (e) { console.warn("[mixFx] could not apply the EQ to the engine:", e); }
}

/** A lane's EQ (the master EQ for MASTER_LANE), normalised; flat when none is saved. */
export function getLaneEq(lane) {
  return normalizeEq(findEffect(fxEntry(lane)?.fx, EQ_ID));
}

/** Set, play and save a lane's EQ. Returns it normalised, or null for an unknown lane. */
export function setLaneEq(lane, descriptor, { save = true } = {}) {
  const entry = fxEntry(lane);
  if (!entry) return null;
  const eq = normalizeEq(descriptor);
  entry.fx = withEffect(entry.fx, EQ_ID, eqIsEmpty(eq) ? null : eq);
  playLaneEq(lane, eq);
  if (save) hooks.save();
  emitFxChange({ lane, eq });
  return eq;
}

/** The song's master settings, normalised; off when none are saved. */
export function getMaster() {
  return normalizeMaster(findEffect(fxEntry(MASTER_LANE).fx, MASTER_ID));
}

/** Save the master settings; the live preview follows through onFxChange. */
export function setMaster(descriptor, { save = true } = {}) {
  const master = normalizeMaster(descriptor);
  const entry = fxEntry(MASTER_LANE);
  entry.fx = withEffect(entry.fx, MASTER_ID, master);
  if (save) hooks.save();
  emitFxChange({ lane: MASTER_LANE, master });
  return master;
}

/** cb({lane, eq}), cb({lane: MASTER_LANE, master}), or cb({lane: null}) after applyAllFx. */
export function onFxChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Push every saved EQ into the engine at once; call when an engine is up. */
export function applyAllFx() {
  for (const name of hooks.laneNames()) {
    if (mixerState[name]) playLaneEq(name, getLaneEq(name), { immediate: true });
  }
  playLaneEq(MASTER_LANE, getLaneEq(MASTER_LANE), { immediate: true });
  emitFxChange({ lane: null });
}
