// Native BiquadFilterNodes only, so the EQ also runs over plain HTTP and on
// phones without AudioWorklet; slots appear only once they change the sound.

import { dbToGain, gainToDb } from "./audioMath.js";
import { PARAM_RAMP, RELEASE_MS, XFADE, chain, disconnectQuietly, rampTo } from "./audioGraph.js";
import { eqIsFlat, eqSections, nodeQ } from "./eqMath.js";
import { MasterStage } from "./masterFx.js";

const SILENT_GAIN = 1e-12;
const TAP_DEFAULTS = Object.freeze({ fftSize: 8192, smoothing: 0.8 });
const MASTER_TAP_KEY = "\u0000master";
/** Where a spectrum tap listens: before or after the EQ. */
export const TAP_SIDE = Object.freeze({ pre: "pre", post: "post" });

const signature = (sections) => sections.map((s) => s.type).join(",");
const toDb = (gain) => gainToDb(gain || SILENT_GAIN);

function buildBranch(ctx, input, out, sections) {
  const nodes = sections.map((s) => {
    const node = ctx.createBiquadFilter();
    node.type = s.type;
    node.frequency.value = s.f;
    node.Q.value = nodeQ(s);
    node.gain.value = s.g;
    return node;
  });
  const wet = ctx.createGain();
  wet.gain.value = 0;
  chain(input, ...nodes, wet, out);
  return { sig: signature(sections), nodes, wet };
}

function dropBranch(input, branch) {
  disconnectQuietly(input, branch.nodes[0] || branch.wet);
  for (const node of [...branch.nodes, branch.wet]) disconnectQuietly(node);
}

function retune(branch, sections, ctx, immediate) {
  sections.forEach((s, i) => {
    const node = branch.nodes[i];
    rampTo(node.frequency, s.f, ctx, { immediate });
    rampTo(node.Q, nodeQ(s), ctx, { immediate });
    rampTo(node.gain, s.g, ctx, { immediate });
  });
}

/** One EQ slot: input -> dry -> output, plus input -> biquads -> wet -> output. */
export class FxSlot {
  #ctx;
  #dry;
  #branch = null;
  #disposed = false;
  #fading = new Map();

  constructor(ctx) {
    this.#ctx = ctx;
    this.input = ctx.createGain();
    this.#dry = ctx.createGain();
    this.output = ctx.createGain();
    chain(this.input, this.#dry, this.output);
  }

  /** Apply a normalised EQ descriptor; `immediate` for a slot not sounding yet. */
  setEq(eq, { immediate = false } = {}) {
    if (this.#disposed) return;
    if (immediate) this.#flushFading();
    this.#setSections(eqSections(eq), immediate);
    const ctx = this.#ctx;
    rampTo(this.#dry.gain, this.#branch ? 0 : 1, ctx, { immediate, time: XFADE });
    if (this.#branch) rampTo(this.#branch.wet.gain, 1, ctx, { immediate, time: XFADE });
    const outDb = eq && !eq.bypass ? eq.params.out : 0;
    rampTo(this.output.gain, outDb === 0 ? 1 : dbToGain(outDb), ctx, { immediate, time: PARAM_RAMP });
  }

  /** What the filters in the graph now do, read from the nodes, in dB. */
  getNodeResponseDb(freqs) {
    const f32 = Float32Array.from(freqs);
    const db = new Float64Array(f32.length).fill(toDb(this.output.gain.value));
    const mag = new Float32Array(f32.length);
    const phase = new Float32Array(f32.length);
    for (const node of this.#branch?.nodes || []) {
      node.getFrequencyResponse(f32, mag, phase);
      for (let i = 0; i < db.length; i++) db[i] += toDb(mag[i]);
    }
    return db;
  }

  sectionCount() {
    return this.#branch?.nodes.length || 0;
  }

  dispose() {
    this.#disposed = true;
    this.#flushFading();
    if (this.#branch) dropBranch(this.input, this.#branch);
    this.#branch = null;
    for (const node of [this.input, this.#dry, this.output]) disconnectQuietly(node);
  }

  #setSections(sections, immediate) {
    const current = this.#branch;
    if (current && sections.length && current.sig === signature(sections)) {
      retune(current, sections, this.#ctx, immediate);
      return;
    }
    this.#branch = sections.length ? buildBranch(this.#ctx, this.input, this.output, sections) : null;
    if (current) this.#release(current, immediate);
  }

  #release(old, immediate) {
    if (immediate) {
      dropBranch(this.input, old);
      return;
    }
    rampTo(old.wet.gain, 0, this.#ctx, { time: XFADE });
    const timer = setTimeout(() => {
      this.#fading.delete(timer);
      dropBranch(this.input, old);
    }, RELEASE_MS);
    this.#fading.set(timer, old);
  }

  #flushFading() {
    for (const [timer, old] of this.#fading) {
      clearTimeout(timer);
      dropBranch(this.input, old);
    }
    this.#fading.clear();
  }
}

/**
 * AnalyserNodes for a spectrum display, one per key, fed by every node of a
 * lane (the "original" lane can be several stems), disconnected on release.
 */
class TapRegistry {
  #ctx;
  #taps = new Map();

  constructor(ctx) {
    this.#ctx = ctx;
  }

  get(key, sourceNodes, opts = {}) {
    const tap = this.#taps.get(key) || this.#create(key, opts);
    for (const node of sourceNodes) {
      if (tap.sources.includes(node)) continue;
      node.connect(tap.analyser);
      tap.sources.push(node);
    }
    return tap.analyser;
  }

  release(key) {
    const tap = this.#taps.get(key);
    if (!tap) return;
    for (const node of tap.sources) disconnectQuietly(node, tap.analyser);
    this.#taps.delete(key);
  }

  releaseAll() {
    for (const key of [...this.#taps.keys()]) this.release(key);
  }

  #create(key, opts) {
    const analyser = this.#ctx.createAnalyser();
    analyser.fftSize = opts.fftSize ?? TAP_DEFAULTS.fftSize;
    analyser.smoothingTimeConstant = opts.smoothing ?? TAP_DEFAULTS.smoothing;
    const tap = { analyser, sources: [] };
    this.#taps.set(key, tap);
    return tap;
  }
}

/**
 * Lane slots for the lanes `membersOf(name)` returns (each {controlName,
 * gain, analyser}, given `.fx` once it has a slot) and the master chain after
 * the master gain, each built only when needed.
 */
export class EngineFx {
  #ctx;
  #membersOf;
  #laneEq = new Map();
  #slots = new Set();
  #taps;
  #masterNode = null;
  #chain = null;

  constructor(ctx, membersOf) {
    this.#ctx = ctx;
    this.#membersOf = membersOf;
    this.#taps = new TapRegistry(ctx);
  }

  attachLane(member) {
    member.gain.connect(member.analyser);
    const eq = this.#laneEq.get(member.controlName);
    if (eq && !eqIsFlat(eq)) this.#slotOf(member).setEq(eq, { immediate: true });
  }

  attachMaster(node) {
    this.#masterNode = node;
    node.connect(this.#ctx.destination);
  }

  setLaneEq(name, eq, opts = {}) {
    this.#laneEq.set(name, eq);
    const members = this.#membersOf(name);
    for (const member of members) {
      if (member.fx || !eqIsFlat(eq)) this.#slotOf(member).setEq(eq, opts);
    }
    return members.length > 0;
  }

  setMasterEq(eq, opts = {}) {
    if (this.#chain || !eqIsFlat(eq)) this.#ensureChain().slot.setEq(eq, opts);
    return true;
  }

  /** The live master: masterFx params, or null to take it out. */
  setMasterFx(params, opts) {
    if (!params && !this.#chain) return false;
    return this.#ensureChain().stage.set(params, opts);
  }

  warmMasterFx(on, params) {
    if (!on && !this.#chain) return true;
    return this.#ensureChain().stage.warm(on, params);
  }

  getMasterFxNodes() { return this.#chain?.stage.nodes() ?? null; }
  masterFxReduction() { return this.#chain?.stage.reduction() ?? null; }
  masterFxLatency() { return this.#chain?.stage.latency() ?? 0; }

  /** The node that feeds the destination. */
  masterOutput() {
    return this.#chain ? this.#chain.stage.output : this.#masterNode;
  }

  getLaneTap(name, which, opts) {
    const nodes = this.#membersOf(name).map((m) => (which === TAP_SIDE.pre ? m.gain : this.#slotOf(m).output));
    return nodes.length ? this.#taps.get(`${name}|${which}`, nodes, opts) : null;
  }

  releaseLaneTap(name, which) {
    this.#taps.release(`${name}|${which}`);
  }

  getMasterTap(which, opts) {
    const node = which === TAP_SIDE.pre ? this.#masterNode : this.#ensureChain().slot.output;
    return this.#taps.get(`${MASTER_TAP_KEY}|${which}`, [node], opts);
  }

  releaseMasterTap(which) {
    this.#taps.release(`${MASTER_TAP_KEY}|${which}`);
  }

  getLaneNodeResponseDb(name, freqs) {
    const [member] = this.#membersOf(name);
    if (!member) return null;
    return member.fx ? member.fx.getNodeResponseDb(freqs) : new Float64Array(freqs.length);
  }

  getMasterNodeResponseDb(freqs) {
    return this.#chain?.slot.getNodeResponseDb(freqs) ?? new Float64Array(freqs.length);
  }

  laneSectionCount(name) {
    return this.#membersOf(name).reduce((n, m) => n + (m.fx?.sectionCount() || 0), 0);
  }

  dispose() {
    this.#taps.releaseAll();
    for (const slot of this.#slots) slot.dispose();
    this.#chain?.slot.dispose();
    this.#chain?.stage.dispose();
  }

  #slotOf(member) {
    if (member.fx) return member.fx;
    const slot = new FxSlot(this.#ctx);
    slot.output.connect(member.analyser);
    member.gain.connect(slot.input);
    member.gain.disconnect(member.analyser);
    member.fx = slot;
    this.#slots.add(slot);
    return slot;
  }

  #ensureChain() {
    if (this.#chain) return this.#chain;
    const slot = new FxSlot(this.#ctx);
    const stage = new MasterStage(this.#ctx);
    slot.output.connect(stage.input);
    stage.output.connect(this.#ctx.destination);
    this.#masterNode.connect(slot.input);
    this.#masterNode.disconnect(this.#ctx.destination);
    this.#chain = { slot, stage };
    return this.#chain;
  }
}

const ENGINE_FX_METHODS = Object.freeze([
  "setLaneEq",
  "setMasterEq",
  "getLaneTap",
  "releaseLaneTap",
  "getMasterTap",
  "releaseMasterTap",
  "getLaneNodeResponseDb",
  "getMasterNodeResponseDb",
  "laneSectionCount",
  "setMasterFx",
  "warmMasterFx",
  "getMasterFxNodes",
  "masterFxReduction",
  "masterFxLatency",
]);

/** The effects surface both engines expose, spread into the engine object. */
export function engineFxApi(fx) {
  const api = { supportsEq: true, supportsMaster: true };
  for (const name of ENGINE_FX_METHODS) api[name] = fx[name].bind(fx);
  return api;
}
