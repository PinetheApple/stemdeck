// Run:  node tests/js/fx-chain.test.mjs

import { flatEq, normalizeEq } from "../../static/js/eqMath.js";
import { PARAM_RAMP } from "../../static/js/audioGraph.js";
import { EngineFx, FxSlot } from "../../static/js/fxChain.js";
import { FakeContext, createChecker, near } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
const eqOf = (bands, out = 0) => normalizeEq({ params: { out, bands } });
const BELL_AND_CUT = eqOf([{ type: "bell", f: 1000, g: 6, q: 2 }, { type: "lowcut", f: 80, slope: 24 }], 2);
const isRamp = (event) => Array.isArray(event) && event[0] === "ramp";

function dryOf(slot) {
  return slot.input.out.map((edge) => edge.destination).find((node) => node.kind === "gain");
}

function firstBiquad(slot) {
  return slot.input.out.map((edge) => edge.destination).find((node) => node.kind === "biquad");
}

{
  const ctx = new FakeContext();
  const slot = new FxSlot(ctx);
  check("an empty slot is input -> dry -> output", dryOf(slot)?.feeds(slot.output) && slot.sectionCount() === 0);
  slot.setEq(BELL_AND_CUT, { immediate: true });
  const first = firstBiquad(slot);
  check("an EQ builds one biquad per section", slot.sectionCount() === 3);
  check("the first biquad carries the band", first.type === "peaking" && first.frequency.value === 1000
    && first.gain.value === 6 && first.Q.value === 2);
  check("dry off, output carries the out gain", dryOf(slot).gain.value === 0
    && near(slot.output.gain.value, 10 ** (2 / 20), 1e-12));

  slot.setEq(eqOf([{ type: "bell", f: 1500, g: 3, q: 2 }, { type: "lowcut", f: 90, slope: 24 }], 2));
  const ramp = first.frequency.events.find(isRamp);
  check("same structure: the same nodes, ramped", firstBiquad(slot) === first && ramp?.[1] === 1500);
  check("a ramp lasts PARAM_RAMP and ends on the exact value",
    near(ramp[2] - ctx.currentTime, PARAM_RAMP, 1e-12) && first.frequency.value === 1500);
  check("ramps start from the current value, never cancelAndHold",
    !ctx.nodes.some((node) => ["frequency", "Q", "gain"].some((p) => node[p]?.events.includes("hold"))));

  slot.setEq({ ...BELL_AND_CUT, bypass: true });
  check("bypass: dry back to exactly 1, output exactly 1", dryOf(slot).gain.value === 1 && slot.output.gain.value === 1);
  check("bypass: the filters fade out before they go", slot.input.feeds(first));
  slot.setEq({ ...BELL_AND_CUT, bypass: true }, { immediate: true });
  check("bypass: no filter node is left", slot.sectionCount() === 0 && !firstBiquad(slot));

  slot.setEq(BELL_AND_CUT, { immediate: true });
  const old = firstBiquad(slot);
  slot.setEq(eqOf([{ type: "highcut", f: 5000, slope: 48 }]));
  check("a new structure builds a new branch", slot.sectionCount() === 4);
  check("the old branch stays connected while it fades", slot.input.feeds(old));
  check("the old branch fades to 0", ctx.ofKind("gain").some((g) => g.gain.events.some((e) => isRamp(e) && e[1] === 0)));
  slot.setEq(flatEq(), { immediate: true });
  check("flat with immediate drops every filter", slot.sectionCount() === 0 && !firstBiquad(slot));
  check("flat: dry 1, output 1", dryOf(slot).gain.value === 1 && slot.output.gain.value === 1);
  slot.dispose();
}

function laneMember(ctx, controlName) {
  return { controlName, gain: ctx.createGain(), analyser: ctx.createAnalyser() };
}

{
  const ctx = new FakeContext();
  const members = [laneMember(ctx, "original"), laneMember(ctx, "original"), laneMember(ctx, "vocals")];
  const fx = new EngineFx(ctx, (name) => members.filter((m) => m.controlName === name));
  const master = ctx.createGain();
  const before = ctx.nodes.length;
  for (const m of members) fx.attachLane(m);
  fx.attachMaster(master);
  fx.setLaneEq("vocals", flatEq());
  fx.setMasterEq(flatEq());
  check("flat: no node is built at all", ctx.nodes.length === before);
  check("flat: gain feeds the analyser directly", members.every((m) => m.gain.feeds(m.analyser)));
  check("flat: master feeds the destination directly", master.feeds(ctx.destination));

  fx.setLaneEq("original", eqOf([{ type: "bell", f: 300, g: -4 }]));
  const [a, b, vocals] = members;
  check("an EQ inserts a slot between gain and analyser", !a.gain.feeds(a.analyser)
    && a.gain.feeds(a.fx.input) && a.fx.output.feeds(a.analyser));
  check("every source of the lane gets it", a.fx.sectionCount() === 1 && b.fx.sectionCount() === 1);
  check("other lanes stay untouched", !vocals.fx && vocals.gain.feeds(vocals.analyser));
  check("the lane counts its sections", fx.laneSectionCount("original") === 2);

  const late = laneMember(ctx, "original");
  members.push(late);
  fx.attachLane(late);
  check("a source attached later still gets the lane's EQ", late.fx?.sectionCount() === 1);

  fx.setMasterEq(eqOf([{ type: "highshelf", f: 8000, g: 2 }]));
  check("a master EQ inserts the master chain", !master.feeds(ctx.destination)
    && ctx.destination === fx.masterOutput().out[0]?.destination);
  check("the master EQ has its filter", ctx.ofKind("biquad").some((n) => n.type === "highshelf"));

  const tap = fx.getLaneTap("original", "post", { fftSize: 4096 });
  check("one post tap per lane, after every source's EQ", members.filter((m) => m.controlName === "original")
    .every((m) => m.fx.output.feeds(tap)) && tap.fftSize === 4096);
  check("asking again returns the same tap", fx.getLaneTap("original", "post") === tap);
  const pre = fx.getLaneTap("vocals", "pre");
  check("a pre tap hangs off the lane's gain", vocals.gain.feeds(pre));
  fx.releaseLaneTap("original", "post");
  check("releasing a tap disconnects it", !a.fx.output.feeds(tap));
  check("an unknown lane has no tap", fx.getLaneTap("nope", "pre") === null);
  fx.dispose();
  check("dispose drops every filter", a.fx.sectionCount() === 0);
}

finish();
