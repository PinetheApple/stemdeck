// Run:  node tests/js/eq-master-lossy.test.mjs

import { createChecker, installPageStubs } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
installPageStubs();
const JOB = "job-lossy";
const PLAN = { gain_db: 2.5, comp_threshold_db: null, pre: { i: -16.5 }, post: { i: -14 } };
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(new URL(url, "http://x"));
  return { ok: true, json: async () => PLAN };
};

const state = await import("../../static/js/state.js");
const mixer = await import("../../static/js/mixer.js");
const master = await import("../../static/js/masterEngine.js");

state.setAudioEngine({ supportsMaster: true, setMasterFx() {}, warmMasterFx() {} });
mixer.ensureMixerStateDefaults();
state.setCurrentJobId(JOB);
master.setMixSource(() => ({ jobId: JOB, query: "stems=drums&gains=1.000" }));
master.setMasterOn(true);

for (const format of ["mp3", "ogg", "mp4"]) {
  master.setExportFormat(format);
  await master.measure();
  check(`${format}: the plan is measured for a lossy export`, asked.at(-1).searchParams.get("lossy") === "1");
}
for (const format of ["wav", "flac"]) {
  master.setExportFormat(format);
  await master.measure();
  check(`${format}: no lossy flag`, !asked.at(-1).searchParams.has("lossy"));
}
master.setExportFormat("wav");
const wavPlan = (await master.measure(), master.getPlan());
master.setExportFormat("mp3");
check("switching to a lossy format makes the old plan stale", wavPlan !== null && master.getPlan() === null);

finish();
