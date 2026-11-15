// The public EQ and master modules (static/js/eqEngine.js, masterEngine.js)
// over the mix store and a fake engine: preview without saving, responses at
// the live rate, the export parameters, the streaming default, the measured
// plan and the live loudness match.
//
// Run:  node tests/js/eq-master-engine.test.mjs

import { createChecker, near } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
globalThis.window = {};
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: { lang: "en", dataset: {} },
};

const state = await import("../../static/js/state.js");
const mixer = await import("../../static/js/mixer.js");
const eq = await import("../../static/js/eqEngine.js");
const master = await import("../../static/js/masterEngine.js");
const { eqResponseDb, normalizeEq } = await import("../../static/js/eqMath.js");

const JOB = "job-master";
const LIVE_RATE = 48000;
const BOOST = { id: "eq", v: 1, params: { out: 0, bands: [{ type: "bell", f: 2000, g: 5, q: 1 }] } };
const PLAN = { gain_db: 3.2, comp_threshold_db: null, pre: { i: -17.2 }, post: { i: -14 } };
const decode = (param) => JSON.parse(Buffer.from(param, "base64url").toString("utf8"));

const calls = [];
state.setAudioEngine({
  supportsEq: true,
  supportsMaster: true,
  audioContext: { sampleRate: LIVE_RATE },
  setLaneEq: (name, d, opts) => calls.push(["lane", name, d, opts]),
  setMasterEq: (d, opts) => calls.push(["masterEq", d, opts]),
  setMasterFx: (params, opts) => calls.push(["fx", params, opts]),
  warmMasterFx: (on, params) => calls.push(["warm", on, params]),
});
mixer.ensureMixerStateDefaults();
state.setCurrentJobId(JOB);
const lastCall = (kind) => calls.filter((c) => c[0] === kind).at(-1);

{
  mixer.setLaneEq("drums", BOOST);
  eq.setBypass("drums", true);
  check("bypass is saved and keeps the bands", mixer.getLaneEq("drums").bypass === true
    && mixer.getLaneEq("drums").params.bands.length === 1);
  check("a bypassed lane is not active", !eq.isLaneActive("drums"));
  eq.setBypass("drums", false);
  eq.previewLaneEq("drums", { id: "eq", v: 1, params: { bands: [] } });
  check("a preview plays without saving", lastCall("lane")[2].params.bands.length === 0
    && mixer.getLaneEq("drums").params.bands.length === 1);
  eq.previewLaneEq("drums", null);
  check("preview null goes back to the saved EQ", lastCall("lane")[2].params.bands.length === 1);
  const freqs = [100, 2000, 10000];
  const live = eq.getFrequencyResponse("drums", freqs);
  const expected = eqResponseDb(normalizeEq(BOOST), freqs, LIVE_RATE);
  check("the response is computed at the live rate", live.every((v, i) => near(v, expected[i], 1e-4)));
  check("no fx param while every EQ is flat", eq.exportFxParam(["vocals"]) === "");
  const fxParam = decode(eq.exportFxParam(["drums", "vocals"]));
  check("the fx param carries the lane", !!fxParam.lanes.drums && !fxParam.lanes.vocals);
  eq.resetLane("drums");
  check("reset leaves the lane flat", !eq.isLaneActive("drums"));
}

{
  check("mastering starts off", !master.isMasterOn() && master.exportMasterParam() === "");
  master.setMasterOn(true);
  check("switched on, the master is streaming", master.getMaster().params.preset === "streaming");
  check("the export carries -14 LUFS / -1 dBTP",
    JSON.stringify(decode(master.exportMasterParam())) === JSON.stringify({ v: 1, target: -14, ceiling: -1 }));
  const [, params] = lastCall("fx");
  check("the engine gets the live master with the fader", params?.ceiling === -1 && params.fader === state.masterVolume);
  master.setMasterOn(false);
  check("switched off, the engine takes it out", lastCall("fx")[1] === null && master.exportMasterParam() === "");
}

{
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => PLAN };
  };
  master.setMasterOn(true);
  master.setMixSource(() => ({ jobId: JOB, query: "stems=drums" }));
  await master.measure();
  check("the plan is measured on the loudness route", urls.at(-1)?.startsWith(`/api/jobs/${JOB}/mixdown/loudness?`)
    && urls.at(-1).includes("master="));
  check("the plan belongs to the current mix", master.getPlan()?.gain_db === 3.2 && master.getPlanState() === "ready");
  check("the live gain is the plan's", master.liveParams().gainDb === 3.2);
  check("the match uses the plan's difference at first", near(master.liveParams().diffLu, 3.2, 1e-9));
  for (let i = 0; i < 30; i++) master.noteLiveLoudness(-20, -18);
  check("after 3 s of sound the match uses the live loudness", near(master.liveParams().diffLu, 2, 1e-9));
  master.warmLive(true);
  check("warming hands the engine the master it would switch on", lastCall("warm")[1] === true
    && lastCall("warm")[2].ceiling === -1);
  mixer.applyAllFx();
  check("a reloaded song re-applies the master at once", lastCall("fx")[2]?.immediate === true);
  master.resetForSong();
  check("a new song forgets the plan", master.getPlan() === null && master.getListen() === "master");
}

finish();
