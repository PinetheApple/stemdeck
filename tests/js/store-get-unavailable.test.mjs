// The desktop store when the shell cannot open it (static/js/utils.js).
//
// The shell answers "user-data-unavailable: ..." while user-data.json is there
// but cannot be read, or the jobs folder cannot be reached. The page opens the
// store once with store_ready before the first read; on that error it reports
// it once and the read or write never settles, so no stand-in is ever saved.
//
// Run:  node tests/js/store-get-unavailable.test.mjs

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ""}`);
  }
}

const warnings = [];
console.warn = (...args) => warnings.push(args.map(String).join(" "));
globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const PENDING = Symbol("pending");
const SETTLE_MS = 50;
const settled = (promise) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(PENDING), SETTLE_MS))]);

function bridge(answer) {
  const calls = [];
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        calls.push(cmd);
        return answer(cmd, args);
      },
    },
  };
  return calls;
}

// A fresh copy of the module for each case: it opens the store once.
let copies = 0;
const load = () => import(`../../static/js/utils.js?case=${++copies}`);

// 1. store_ready fails: reported once, nothing read, nothing settles.
{
  const calls = bridge((cmd) => {
    if (cmd === "store_ready") throw "user-data-unavailable: user-data.json could not be read";
    return { folders: ["Rock"] };
  });
  const utils = await load();
  const seen = [];
  utils.onStoreUnavailable((err) => seen.push(String(err)));
  const got = await settled(utils.storeGet("stemdeck.folders", { folders: [] }));
  check("a store that cannot open: the read never settles", got === PENDING, String(got));
  check("no stand-in: store_get is never asked", !calls.includes("store_get"), calls.join());
  const wrote = await settled(utils.storeSet("stemdeck.folders", { folders: [] }));
  check("a store that cannot open: the write never settles", wrote === PENDING, String(wrote));
  check("nothing written", !calls.includes("store_set"), calls.join());
  check("reported once", seen.length === 1 && seen[0].startsWith("user-data-unavailable"), seen.join(" | "));
}

// 2. A failure before the handler is registered is handed over on registration.
{
  bridge((cmd) => {
    if (cmd === "store_ready") throw "user-data-unavailable: locked";
    return null;
  });
  const utils = await load();
  await settled(utils.storeGet("k"));
  const seen = [];
  utils.onStoreUnavailable((err) => seen.push(String(err)));
  check("reported on registration", seen.length === 1, seen.join(" | "));
}

// 3. Ready, then the store is lost (the library moved to a drive that is gone).
{
  let lost = false;
  const calls = bridge((cmd) => {
    if (lost && cmd !== "store_ready") throw "user-data-unavailable: failed to create E:\\jobs";
    if (cmd === "store_get") return { folders: ["Rock"] };
    return null;
  });
  const utils = await load();
  const seen = [];
  utils.onStoreUnavailable((err) => seen.push(String(err)));
  const got = await utils.storeGet("stemdeck.folders", null);
  check("ready: the real value", JSON.stringify(got) === '{"folders":["Rock"]}', JSON.stringify(got));
  const readies = calls.filter((c) => c === "store_ready").length;
  check("store_ready came first, once", calls[0] === "store_ready" && readies === 1, calls.join());
  check("a write that works resolves true", (await utils.storeSet("a", 1)) === true);

  lost = true;
  check("a write to a lost store resolves false", (await utils.storeSet("a", 2)) === false);
  check("and is reported", seen.length === 1, seen.join(" | "));
  const read = await settled(utils.storeGet("stemdeck.folders", "stand-in"));
  check("a read from a lost store never settles", read === PENDING, String(read));
  check("reported once only", seen.length === 1, seen.join(" | "));
}

// 4. Any other error: false or the fallback at once, logged, not reported.
{
  bridge((cmd) => {
    if (cmd === "store_ready") return null;
    throw "disk full";
  });
  const utils = await load();
  const seen = [];
  utils.onStoreUnavailable((err) => seen.push(String(err)));
  warnings.length = 0;
  check("another failed write resolves false", (await utils.storeSet("a", 1)) === false);
  check("another failed read gives the fallback", (await utils.storeGet("a", "fallback")) === "fallback");
  check("logged", warnings.length === 2, warnings.join(" | "));
  check("not reported as unavailable", seen.length === 0);
}

// 5. The store opened but nothing could be recovered: said once, reads go on.
{
  bridge((cmd) => {
    if (cmd === "store_ready") return { lost: true };
    if (cmd === "store_get") return null;
    return null;
  });
  const utils = await load();
  const lost = [];
  const unavailable = [];
  utils.onStoreUnavailable((err) => unavailable.push(err));
  const got = await settled(utils.storeGet("stemdeck.folders", "empty"));
  check("a lost store still reads", got === "empty", String(got));
  utils.onStoreLost(() => lost.push(1));
  await utils.storeGet("k");
  check("lost is said once, also to a late handler", lost.length === 1, String(lost.length));
  check("lost is not unavailable", unavailable.length === 0);
}

// 6. A store that opened normally says nothing.
{
  bridge((cmd) => (cmd === "store_ready" ? { lost: false } : null));
  const utils = await load();
  const lost = [];
  utils.onStoreLost(() => lost.push(1));
  await utils.storeGet("k");
  check("a normal open is not lost", lost.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
