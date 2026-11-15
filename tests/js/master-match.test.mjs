// Run:  node tests/js/master-match.test.mjs

import { createChecker, installPageStubs } from "./fakeWebAudio.mjs";

const { check, finish } = createChecker();
const MATCH_KEY = "stemdeck.master.match";
installPageStubs();

const pendingReads = [];
function invoke(cmd, args) {
  if (cmd === "store_get" && args?.key === MATCH_KEY) {
    return new Promise((resolve) => pendingReads.push(resolve));
  }
  return Promise.resolve(cmd === "store_ready" ? {} : null);
}
globalThis.window.__TAURI__ = { core: { invoke } };

const state = await import("../../static/js/state.js");
const engineCalls = [];
state.setAudioEngine({ supportsMaster: true, setMasterFx: (params) => engineCalls.push(params) });

async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function loadFreshEngine(tag) {
  const engine = await import(`../../static/js/masterEngine.js?${tag}`);
  await settle();
  return { engine, resolveRead: pendingReads.pop() };
}

{
  const { engine, resolveRead } = await loadFreshEngine("late-read");
  const events = [];
  engine.onChange((what) => events.push(what));
  const callsBefore = engineCalls.length;
  resolveRead(false);
  await settle();
  check("a late store read is adopted", engine.getMatch() === false);
  check("a late store read re-applies the master", engineCalls.length > callsBefore);
  check("a late store read announces the listen change", events.includes(engine.MASTER_EVENT.listen));
}

{
  const { engine, resolveRead } = await loadFreshEngine("choice-first");
  engine.setMatch(false);
  resolveRead(true);
  await settle();
  check("a choice made before the read resolves wins", engine.getMatch() === false);
}

finish();
