// Run:  node tests/js/mix-fx.test.mjs

import { createChecker, installPageStubs } from "./fakeWebAudio.mjs";

const memory = installPageStubs();
const fx = await import("../../static/js/mixFx.js");
const mixer = await import("../../static/js/mixer.js");
const state = await import("../../static/js/state.js");
const { storeFlushPending } = await import("../../static/js/utils.js");
const { MASTER_LANE, normalizeLaneFx, normalizeMasterEntry } = fx;
const { check, finish } = createChecker();
const BOOST = { id: "eq", v: 1, bypass: false, params: { out: 0, bands: [{ type: "bell", f: 500, g: 4 }] } };
const STREAMING = { id: "master", v: 1, bypass: false, params: { preset: "streaming" } };

{
  check("a missing fx list is flat", JSON.stringify(normalizeLaneFx(undefined)) === "[]");
  check("a non-array fx list is flat", JSON.stringify(normalizeLaneFx({ id: "eq" })) === "[]");
  check("an unknown effect id is dropped", normalizeLaneFx([{ id: "reverb", v: 1 }]).length === 0);
  check("an EQ from a newer version is dropped", normalizeLaneFx([{ ...BOOST, v: 2 }]).length === 0);
  check("a master entry in a lane is dropped", normalizeLaneFx([STREAMING]).length === 0);
  const kept = normalizeLaneFx([BOOST, BOOST]);
  check("one valid EQ is kept, normalised", kept.length === 1 && kept[0].params.bands[0].q === 0.707);
  check("an EQ with nothing in it is not stored", normalizeLaneFx([{ id: "eq", v: 1, params: {} }]).length === 0);
}

{
  check("the master lane id", MASTER_LANE === "__master");
  check("no master entry: no effects", JSON.stringify(normalizeMasterEntry(null)) === '{"fx":[]}');
  check("a non-array master list: no effects", normalizeMasterEntry({ fx: "x" }).fx.length === 0);
  const both = normalizeMasterEntry({ fx: [STREAMING, BOOST, { id: "master", v: 9 }] });
  check("master EQ first, then the master", both.fx.map((d) => d.id).join() === "eq,master");
  check("the master is normalised", both.fx[1].params.target_lufs === -14);
  check("a newer master is dropped (off)", normalizeMasterEntry({ fx: [{ ...STREAMING, v: 2 }] }).fx.length === 0);
}

const JOB = "job-eq";
const MIX_KEY = `stemdeck:mix:${JOB}`;

const engineCalls = [];
const fakeEngine = {
  supportsEq: true,
  setLaneEq: (name, eq, opts) => engineCalls.push(["lane", name, eq, opts]),
  setMasterEq: (eq, opts) => engineCalls.push(["master", eq, opts]),
};

{
  memory.set(MIX_KEY, JSON.stringify({
    bass: { volume: 0.5, fx: "garbage" },
    drums: { fx: [BOOST] },
    __master: { fx: [STREAMING] },
    globalPitch: 0,
  }));
  mixer.ensureMixerStateDefaults();
  await mixer.loadMixIntoState(JOB, ["bass", "drums"]);
  const { mixerState } = state;
  check("load: a garbage lane fx list reads as flat", Array.isArray(mixerState.bass.fx) && !mixerState.bass.fx.length);
  check("load: a lane without fx gets []", Array.isArray(mixerState.vocals.fx) && !mixerState.vocals.fx.length);
  check("load: a stored EQ comes back", fx.getLaneEq("drums").params.bands[0].g === 4);
  check("load: the stored master comes back on", fx.getMaster().bypass === false);
  check("load: other lane fields are untouched", mixerState.bass.volume === 0.5);

  state.setCurrentJobId(JOB);
  state.setAudioEngine(fakeEngine);
  const seen = [];
  const off = fx.onFxChange((change) => seen.push(change));
  const saved = fx.setLaneEq("vocals", BOOST);
  check("set: the EQ is normalised", saved.params.bands[0].q === 0.707);
  check("set: the engine hears it", engineCalls.some(([kind, name]) => kind === "lane" && name === "vocals"));
  check("set: listeners hear it", seen.at(-1)?.lane === "vocals");
  check("set: an unknown lane is refused", fx.setLaneEq("kazoo", BOOST) === null);
  fx.setLaneEq(MASTER_LANE, BOOST);
  check("set: the master EQ goes to the master slot", engineCalls.some(([kind]) => kind === "master"));
  fx.setMaster({ ...STREAMING, bypass: true });
  await storeFlushPending(MIX_KEY);
  const stored = JSON.parse(memory.get(MIX_KEY));
  check("save: the lane EQ is in the stored mix", stored.vocals.fx[0].params.bands[0].g === 4);
  check("save: the master slot is stored EQ first", stored.__master.fx.map((d) => d.id).join() === "eq,master");
  check("save: the global pitch is still stored", stored.globalPitch === 0);
  fx.setLaneEq("vocals", { id: "eq", v: 1, params: {} });
  check("an EQ set back to nothing leaves no entry", state.mixerState.vocals.fx.length === 0);

  engineCalls.length = 0;
  fx.applyAllFx();
  check("applyAllFx pushes every lane and the master at once",
    engineCalls.some(([kind, name, , opts]) => kind === "lane" && name === "drums" && opts?.immediate)
    && engineCalls.some(([kind, , opts]) => kind === "master" && opts?.immediate));
  check("applyAllFx announces a whole-song change", seen.at(-1)?.lane === null);
  off();
  mixer.resetMixerState();
  check("reset: no lane EQ and no master", !state.mixerState.drums.fx.length && !state.mixerState.__master.fx.length);
}

finish();
