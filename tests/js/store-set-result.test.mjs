// storeSet reports whether the write landed, without ever throwing.
//
// It used to swallow every failure, so a library that could not be saved said
// nothing: the callers' .catch could never run. It still must not reject,
// because most callers fire and forget, and a rejection there would surface as
// an unhandled error.
//
// Run:  node tests/js/store-set-result.test.mjs

import { storeSet } from "../../static/js/utils.js";

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};

console.warn = () => {};

function useLocalStorage(setItem) {
  globalThis.window = {};
  globalThis.localStorage = { setItem };
}

function useTauri(invoke) {
  globalThis.window = { __TAURI__: { core: { invoke } } };
}

async function outcome(write) {
  try {
    return { value: await write() };
  } catch (error) {
    return { error };
  }
}

const full = () => {
  throw new Error("QuotaExceededError");
};

useLocalStorage(() => {});
let r = await outcome(() => storeSet("k", { a: 1 }));
check("localStorage write that lands resolves true", r.value === true, JSON.stringify(r));

useLocalStorage(full);
r = await outcome(() => storeSet("k", { a: 1 }));
check("localStorage write that fails resolves false", r.value === false, JSON.stringify(r));

useTauri(async () => null);
r = await outcome(() => storeSet("k", { a: 1 }));
check("desktop store write that lands resolves true", r.value === true, JSON.stringify(r));

useTauri(async () => full());
r = await outcome(() => storeSet("k", { a: 1 }));
check("desktop store write that fails resolves false", r.value === false, JSON.stringify(r));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
