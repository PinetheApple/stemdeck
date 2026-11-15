// The live master: an approximate preview of the export's master
// (app/pipeline/mastering.py renders the exact result with ffmpeg).
//
//   input - pre (1/fader) -+- glue - cancel - gain - limiter - cancel - wet -+- post (fader)
//                          '- delay (the compressors' look-ahead) --- dry ---'
//
// The export never applies the monitoring fader, and the mixer folds it into
// every lane gain, so `pre` undoes it and `post` applies it again. Each
// DynamicsCompressorNode adds a fixed makeup gain that a GainNode cancels.
// The A/B "original" path is delayed by the same look-ahead.

import {
  compressorMakeupGain, glueSettings, limiterSettings, matchedLevels,
} from "./masterMath.js";
import { XFADE, rampTo } from "./paramRamp.js";

/** DynamicsCompressorNode's fixed look-ahead (Web Audio spec pre-delay). */
export const COMPRESSOR_LOOKAHEAD = 0.006;
const COMPRESSORS_IN_SERIES = 2;
const MAX_DELAY_SEC = 0.1;
const MIN_FADER = 1e-3;
const RELEASE_MARGIN = 0.05;
const RELEASE_MS = (XFADE + RELEASE_MARGIN) * 1000;
const LISTEN_ORIGINAL = "original";
const COMPRESSOR_PARAMS = Object.freeze(["threshold", "knee", "ratio", "attack", "release"]);
// Ratio 1 does nothing but keeps the look-ahead, so latency stays constant.
const IDLE_GLUE = Object.freeze({ threshold: 0, knee: 0, ratio: 1, attack: 0.02, release: 0.25 });
const INITIAL_STATE = Object.freeze({
  gainDb: 0, comp: 0, compThresholdDb: null, ceiling: -1, fader: 1, listen: "master", match: true, diffLu: NaN,
});

/** One compressor's look-ahead in seconds: whole frames, as Chromium delays it. */
export function lookaheadSec(rate) {
  return Math.floor(COMPRESSOR_LOOKAHEAD * rate) / rate;
}

function setCompressor(node, cancel, settings, ctx, immediate) {
  for (const name of COMPRESSOR_PARAMS) rampTo(node[name], settings[name], ctx, { immediate });
  const makeup = compressorMakeupGain(settings.threshold, settings.knee, settings.ratio);
  rampTo(cancel.gain, 1 / makeup, ctx, { immediate });
}

function chain(...nodes) {
  nodes.reduce((prev, node) => prev.connect(node));
}

function buildEffectGraph(ctx) {
  const n = {
    input: ctx.createGain(), pre: ctx.createGain(), glue: ctx.createDynamicsCompressor(),
    glueCancel: ctx.createGain(), gain: ctx.createGain(), limiter: ctx.createDynamicsCompressor(),
    limCancel: ctx.createGain(), wet: ctx.createGain(), delay: ctx.createDelay(MAX_DELAY_SEC),
    dry: ctx.createGain(), post: ctx.createGain(),
  };
  chain(n.input, n.pre, n.glue, n.glueCancel, n.gain, n.limiter, n.limCancel, n.wet, n.post);
  chain(n.pre, n.delay, n.dry, n.post);
  n.delay.delayTime.value = COMPRESSORS_IN_SERIES * lookaheadSec(ctx.sampleRate);
  n.dry.gain.value = 0;
  return n;
}

function applyState(n, s, ctx, immediate) {
  const fader = Math.max(0, s.fader);
  const opts = { immediate };
  rampTo(n.pre.gain, fader > MIN_FADER ? 1 / fader : 1, ctx, opts);
  rampTo(n.post.gain, fader, ctx, opts);
  setCompressor(n.glue, n.glueCancel, glueSettings(s.comp, s.compThresholdDb) || IDLE_GLUE, ctx, immediate);
  rampTo(n.gain.gain, 10 ** (s.gainDb / 20), ctx, opts);
  setCompressor(n.limiter, n.limCancel, limiterSettings(s.ceiling), ctx, immediate);
  const levels = matchedLevels(s.diffLu, s.match);
  const original = s.listen === LISTEN_ORIGINAL;
  rampTo(n.wet.gain, original ? 0 : levels.master, ctx, opts);
  rampTo(n.dry.gain, original ? levels.original : 0, ctx, opts);
}

/** The master effect; `set` takes any subset of {gainDb, comp, compThresholdDb, ceiling, fader, listen, match, diffLu}. */
export function createMasterEffect(ctx) {
  const n = buildEffectGraph(ctx);
  let state = { ...INITIAL_STATE };
  return {
    input: n.input,
    output: n.post,
    inTap: n.pre,
    outTap: n.limCancel,
    latencySec: n.delay.delayTime.value,
    set(patch, { immediate = false } = {}) {
      state = { ...state, ...patch };
      applyState(n, state, ctx, immediate);
    },
    reduction: () => ({ glue: n.glue.reduction ?? 0, limiter: n.limiter.reduction ?? 0 }),
    dispose() {
      for (const node of Object.values(n)) node.disconnect();
    },
  };
}

/**
 * The master effect's place in the chain: a straight path at exactly 1 and
 * the effect, crossfaded. The effect exists only while on or kept warm, so
 * off is bit-identical to the input. Kept warm (running, silent), switching
 * on is a crossfade to a settled compressor instead of a new one that starts
 * out compressing hard.
 */
export class MasterStage {
  #ctx;
  #around;
  #live = null;
  #dropTimer = 0;
  #warmWanted = false;

  constructor(ctx) {
    this.#ctx = ctx;
    this.input = ctx.createGain();
    this.#around = ctx.createGain();
    this.output = ctx.createGain();
    chain(this.input, this.#around, this.output);
  }

  /** Switch the effect on with `params`, or off with null. */
  set(params, { immediate = false } = {}) {
    if (!params && !this.#live) return false;
    if (params) this.#switchOn(params, immediate);
    else this.#switchOff(immediate);
    return true;
  }

  /** Keep the effect running, silent, settled on `params` (on), or let it go once off. */
  warm(on, params = null) {
    this.#warmWanted = !!on;
    if (!this.#warmWanted) {
      if (this.#live && !this.#live.active) this.#scheduleDrop(false);
      return true;
    }
    this.#cancelDrop();
    if (!this.#live) this.#live = this.#make(params || {});
    else if (params && !this.#live.active) this.#live.effect.set(params);
    return true;
  }

  /** The effect's In and Out nodes at export level, or null when off. */
  nodes() {
    const live = this.#active();
    return live ? { input: live.effect.inTap, output: live.effect.outTap } : null;
  }

  reduction() { return this.#active()?.effect.reduction() ?? null; }
  latency() { return this.#active()?.effect.latencySec ?? 0; }

  dispose() {
    this.#cancelDrop();
    this.#live?.effect.dispose();
    for (const node of [this.input, this.#around, this.output, this.#live?.wet].filter(Boolean)) node.disconnect();
  }

  #active() {
    return this.#live?.active ? this.#live : null;
  }

  #make(params) {
    const effect = createMasterEffect(this.#ctx);
    const wet = this.#ctx.createGain();
    wet.gain.value = 0;
    chain(this.input, effect.input);
    chain(effect.output, wet, this.output);
    effect.set(params, { immediate: true });
    return { effect, wet, active: false };
  }

  #switchOn(params, immediate) {
    this.#cancelDrop();
    if (this.#live) this.#live.effect.set(params, { immediate });
    else this.#live = this.#make(params);
    this.#live.active = true;
    this.#crossfade(true, immediate);
  }

  #switchOff(immediate) {
    this.#live.active = false;
    this.#crossfade(false, immediate);
    this.#scheduleDrop(immediate);
  }

  #crossfade(on, immediate) {
    rampTo(this.#around.gain, on ? 0 : 1, this.#ctx, { immediate, time: XFADE });
    rampTo(this.#live.wet.gain, on ? 1 : 0, this.#ctx, { immediate, time: XFADE });
  }

  #cancelDrop() {
    clearTimeout(this.#dropTimer);
    this.#dropTimer = 0;
  }

  #scheduleDrop(immediate) {
    this.#cancelDrop();
    if (immediate) this.#drop();
    else this.#dropTimer = setTimeout(() => this.#drop(), RELEASE_MS);
  }

  #drop() {
    this.#dropTimer = 0;
    const live = this.#live;
    if (!live || live.active || this.#warmWanted) return;
    this.input.disconnect(live.effect.input);
    live.effect.dispose();
    live.wet.disconnect();
    this.#live = null;
  }
}
