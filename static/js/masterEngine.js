// The live preview's gain and threshold come from the measured plan of this
// very mix, so the browser never guesses the loudness the export will hit.

import { audioEngine, currentJobId, masterVolume } from "./state.js";
import { storeGet, storeSet } from "./utils.js";
import { MASTER_LANE, getMaster, onFxChange, setMaster } from "./mixFx.js";
import { LISTEN, applyPreset, encodeMasterParam, masterIsOn } from "./masterMath.js";

export {
  LISTEN,
  MASTER_LIMITS,
  MASTER_PRESETS,
  PRESET_ORDER,
  applyPreset,
  normalizeMaster,
} from "./masterMath.js";
export { getMaster, setMaster } from "./mixFx.js";

const MATCH_KEY = "stemdeck.master.match";
const MASTER_QUERY_PARAM = "master";
// While on, the mix is compared with the last one measured this often, and
// measured again once it has stopped changing for SETTLE_MS.
const WATCH_MS = 600;
const SETTLE_MS = 700;
// Meter reads (100 ms apart) of sound before the live loudness match is used.
const LIVE_MATCH_MIN_READS = 30;
const SILENCE_LUFS = -60;
const MATCH_STEP_LU = 0.05;
export const PLAN_STATE = Object.freeze({
  idle: "idle",
  measuring: "measuring",
  ready: "ready",
  error: "error",
});
/** What an onChange callback is told changed; null means a song (re)load. */
export const MASTER_EVENT = Object.freeze({ master: "master", listen: "listen", plan: "plan" });

const listeners = new Set();
let listen = LISTEN.master;
let match = true;
let mixSource = null;
let warm = false;
let inflight = null;
let watchTimer = 0;
let settleTimer = 0;
const plan = { body: null, sig: "", state: PLAN_STATE.idle, wanted: "", job: null };
let live = freshLive();

function freshLive() {
  return { sumIn: 0, sumOut: 0, reads: 0, diff: NaN };
}

storeGet(MATCH_KEY, true).then(adoptStoredMatch);

function adoptStoredMatch(stored) {
  match = stored !== false;
}

function emit(what) {
  for (const cb of listeners) {
    try { cb(what); } catch (e) { console.warn("[master] change listener failed:", e); }
  }
}

/** cb(what): a MASTER_EVENT value, or null after a song (re)load. */
export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isMasterOn() {
  return masterIsOn(getMaster());
}

/** On with the song's settings, or the streaming preset the first time. */
export function setMasterOn(on) {
  return setMaster({ ...getMaster(), bypass: !on });
}

export function choosePreset(preset) {
  return setMaster({ ...applyPreset(getMaster(), preset), bypass: false });
}

/** The export's master= value, "" when mastering is off. */
export function exportMasterParam() {
  return encodeMasterParam(getMaster());
}

export function getListen() { return listen; }
export function getMatch() { return match; }

export function setListen(which) {
  listen = which === LISTEN.original ? LISTEN.original : LISTEN.master;
  applyToEngine();
  emit(MASTER_EVENT.listen);
}

export function setMatch(on) {
  match = !!on;
  storeSet(MATCH_KEY, match);
  applyToEngine();
  emit(MASTER_EVENT.listen);
}

/**
 * One meter read of the live master's momentary loudness at its input and
 * output (LUFS, export level). After LIVE_MATCH_MIN_READS reads of sound the
 * match uses the live difference, which the export's plan only approximates.
 */
export function noteLiveLoudness(inLufs, outLufs) {
  if (!isMasterOn() || !Number.isFinite(inLufs) || !Number.isFinite(outLufs)) return;
  if (inLufs < SILENCE_LUFS || outLufs < SILENCE_LUFS) return;
  live.sumIn += 10 ** (inLufs / 10);
  live.sumOut += 10 ** (outLufs / 10);
  live.reads += 1;
  if (live.reads < LIVE_MATCH_MIN_READS) return;
  const diff = 10 * Math.log10(live.sumOut / live.sumIn);
  if (Number.isFinite(live.diff) && Math.abs(diff - live.diff) < MATCH_STEP_LU) return;
  live.diff = diff;
  if (match) applyToEngine();
}

/** The plan for the current mix and master, null until measured. */
export function getPlan() {
  return plan.sig && plan.sig === signature() ? plan.body : null;
}
export function getPlanState() { return plan.state; }

/** How the export describes the current mix: () => {jobId, query} | null. */
export function setMixSource(fn) {
  mixSource = fn;
}

function signature() {
  const src = mixSource?.();
  if (!src || !isMasterOn()) return "";
  return `${src.jobId}|${src.query}|${exportMasterParam()}`;
}

function stopWatch() {
  clearInterval(watchTimer);
  clearTimeout(settleTimer);
  watchTimer = 0;
  settleTimer = 0;
}

function check() {
  const sig = signature();
  if (!sig || sig === plan.sig || sig === plan.wanted) return;
  plan.wanted = sig;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(measureSettled, plan.body ? SETTLE_MS : 0);
}

function measureSettled() {
  settleTimer = 0;
  measure();
}

/** Follow the mix while mastering is on; stop when it is off. */
export function watch() {
  if (!isMasterOn() || !mixSource) {
    stopWatch();
    return;
  }
  if (!watchTimer) watchTimer = setInterval(check, WATCH_MS);
  check();
}

async function fetchPlan(src, signal) {
  const query = new URLSearchParams(src.query);
  query.set(MASTER_QUERY_PARAM, exportMasterParam());
  const res = await fetch(`/api/jobs/${src.jobId}/mixdown/loudness?${query}`, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function adoptPlan(body, sig, jobId) {
  Object.assign(plan, { body, sig, job: jobId, state: PLAN_STATE.ready });
  live = freshLive();
}

/** Measure the current mix now. Resolves to the plan, or null. */
export async function measure() {
  const src = mixSource?.();
  if (!src || !isMasterOn()) return null;
  const sig = signature();
  inflight?.abort();
  const ctl = new AbortController();
  inflight = ctl;
  plan.state = PLAN_STATE.measuring;
  emit(MASTER_EVENT.plan);
  try {
    const body = await fetchPlan(src, ctl.signal);
    if (inflight !== ctl) return null;
    adoptPlan(body, sig, src.jobId);
  } catch (err) {
    if (ctl.signal.aborted) return null;
    console.warn("[master] measuring the mix failed:", err);
    Object.assign(plan, { state: PLAN_STATE.error, wanted: "" });
  } finally {
    if (inflight === ctl) inflight = null;
  }
  applyToEngine();
  emit(MASTER_EVENT.plan);
  return plan.body;
}

/** A new song: forget the old song's plan and compare state. */
export function resetForSong() {
  inflight?.abort();
  inflight = null;
  Object.assign(plan, { body: null, sig: "", wanted: "", state: PLAN_STATE.idle });
  listen = LISTEN.master;
  live = freshLive();
  stopWatch();
  emit(null);
}

function planDiff(p) {
  return p && Number.isFinite(p.post?.i) && Number.isFinite(p.pre?.i) ? p.post.i - p.pre.i : NaN;
}

function paramsFor(master, overrides) {
  const p = plan.job === currentJobId ? plan.body : null;
  return {
    gainDb: p ? p.gain_db : 0,
    comp: master.params.comp,
    compThresholdDb: p ? p.comp_threshold_db : null,
    ceiling: master.params.ceiling_dbtp,
    fader: masterVolume,
    listen,
    match,
    diffLu: Number.isFinite(live.diff) ? live.diff : planDiff(p),
    ...overrides,
  };
}

/** What the live master runs with now (masterFx set()), or null when off. */
export function liveParams() {
  return isMasterOn() ? paramsFor(getMaster()) : null;
}

/** Push the master to the engine; also call it when the master fader moves. */
export function applyToEngine({ immediate = false } = {}) {
  if (!audioEngine?.supportsMaster) return;
  try {
    audioEngine.setMasterFx(liveParams(), { immediate });
  } catch (e) {
    console.warn("[master] could not apply the master to the engine:", e);
  }
}

/** Keep the live master running, silent, while its panel is open. */
export function warmLive(on) {
  warm = !!on;
  if (!audioEngine?.supportsMaster) return;
  const settled = on ? paramsFor(getMaster(), { listen: LISTEN.master, diffLu: NaN }) : null;
  try {
    audioEngine.warmMasterFx(warm, settled);
  } catch (e) {
    console.warn("[master] could not warm the live master:", e);
  }
}

function followMixChange({ lane }) {
  if (lane === MASTER_LANE) {
    live = freshLive();
    applyToEngine();
    emit(MASTER_EVENT.master);
    watch();
  } else if (lane === null) {
    applyToEngine({ immediate: true });
    if (warm) warmLive(true);
    emit(null);
    watch();
  }
}

onFxChange(followMixChange);
