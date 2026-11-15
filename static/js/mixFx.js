// The effects lists stored with a song's mix: `fx` on every lane (its EQ) and
// the master slot's entry (master EQ, then the master). Pure, so the store's
// normalisation runs in node tests.

import { EQ_ID, EQ_VERSION, normalizeEq } from "./eqMath.js";
import { MASTER_ID, MASTER_VERSION, normalizeMaster } from "./masterMath.js";

/** The master slot's key in the mix (never a lane name). */
export const MASTER_LANE = "__master";

const EFFECT_ORDER = Object.freeze([EQ_ID, MASTER_ID]);

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

/** The descriptor with this id in a stored list, or null. */
export function findEffect(list, id) {
  return (Array.isArray(list) ? list : []).find((d) => d?.id === id) || null;
}

/** The list with the `id` entry replaced by `descriptor` (null removes it), EQ first. */
export function withEffect(list, id, descriptor) {
  const byId = new Map((Array.isArray(list) ? list : []).map((d) => [d?.id, d]));
  if (descriptor) byId.set(id, descriptor);
  else byId.delete(id);
  return EFFECT_ORDER.map((key) => byId.get(key)).filter(Boolean);
}
