// Run:  node tests/js/master-fx.test.mjs

import { EngineFx } from "../../static/js/fxChain.js";
import { lookaheadSec } from "../../static/js/masterFx.js";
import { FakeContext, createChecker, near } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
const PARAMS = {
  gainDb: 3, comp: 0.5, compThresholdDb: -15, ceiling: -1, fader: 0.5, listen: "master", match: true, diffLu: 4,
};
const TWO_LOOKAHEADS_48K = 0.012;

function setup() {
  const ctx = new FakeContext({ sampleRate: 48000 });
  const fx = new EngineFx(ctx, () => []);
  const master = ctx.createGain();
  fx.attachMaster(master);
  return { ctx, fx, master };
}

const gainNear = (ctx, value) => ctx.ofKind("gain").find((g) => near(g.gain.value, value, 1e-12));

{
  const { ctx, fx, master } = setup();
  check("off: no compressor exists", ctx.ofKind("compressor").length === 0);
  check("off: nothing to take out", fx.setMasterFx(null) === false && master.feeds(ctx.destination));
  fx.setMasterFx(PARAMS, { immediate: true });
  const [glue, limiter] = ctx.ofKind("compressor");
  check("on: a glue compressor and a limiter", ctx.ofKind("compressor").length === 2);
  check("the glue gets the measured threshold and 2:1", glue.threshold.value === -15 && glue.ratio.value === 2);
  check("the limiter sits at the ceiling minus the margin, ratio 20",
    near(limiter.threshold.value, -1.1, 1e-9) && limiter.ratio.value === 20);
  check("the fader is undone before the master (1 / 0.5)", !!gainNear(ctx, 2));
  check("the measured gain is applied", !!gainNear(ctx, 10 ** (3 / 20)));
  check("matched: the master is turned down by the difference", !!gainNear(ctx, 10 ** (-4 / 20)));
  const delay = ctx.ofKind("delay")[0];
  check("the original path is delayed by both look-aheads", near(delay.delayTime.value, TWO_LOOKAHEADS_48K, 1e-12));
  check("look-ahead is whole frames at 44.1 kHz", near(lookaheadSec(44100), 264 / 44100, 1e-15));
  check("the meters' nodes are exposed", !!fx.getMasterFxNodes()?.input && !!fx.getMasterFxNodes()?.output);
  check("latency is reported", near(fx.masterFxLatency(), TWO_LOOKAHEADS_48K, 1e-12));
  fx.setMasterFx({ ...PARAMS, listen: "original" }, { immediate: true });
  const dry = ctx.ofKind("gain").find((g) => delay.feeds(g));
  check("original: the delayed dry path plays", near(dry.gain.value, 1, 1e-12));
  fx.setMasterFx({ ...PARAMS, comp: 0 }, { immediate: true });
  check("glue off: the compressor idles at ratio 1", glue.ratio.value === 1);
  fx.setMasterFx(null, { immediate: true });
  check("off again: the effect is gone", fx.getMasterFxNodes() === null && fx.masterFxLatency() === 0);
  check("off again: nothing feeds a compressor",
    ctx.nodes.every((n) => !n.out.some((edge) => edge.destination.kind === "compressor")));
  const around = ctx.ofKind("gain").find((g) => g.feeds(fx.masterOutput()));
  check("off again: the straight path is at exactly 1", around?.gain.value === 1);
  fx.dispose();
}

{
  const { ctx, fx } = setup();
  fx.warmMasterFx(true, PARAMS);
  const warmed = ctx.ofKind("compressor");
  check("warm: the effect runs before it is switched on", warmed.length === 2);
  check("warm: it is silent and not reported as on", fx.getMasterFxNodes() === null);
  const around = ctx.ofKind("gain").find((g) => g.feeds(fx.masterOutput()) && g.gain.value === 1);
  check("warm: the straight path stays at exactly 1", !!around);
  fx.setMasterFx(PARAMS);
  check("switching on reuses the settled effect", ctx.ofKind("compressor").length === 2 && !!fx.getMasterFxNodes());
  fx.setMasterFx(null, { immediate: true });
  check("off while warm: the effect is kept", ctx.nodes.some((n) => n.out.some((e) => e.destination === warmed[0])));
  fx.warmMasterFx(false);
  fx.dispose();
}

finish();
