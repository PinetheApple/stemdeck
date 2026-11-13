// Starting a paused queue says whether it worked, so the Start button can
// recover and the failure is shown rather than swallowed.
//
// Run:  node tests/js/queue-start.test.mjs

globalThis.window = {};
globalThis.document = {
  documentElement: { getAttribute: () => null },
  getElementById: () => null,
  querySelectorAll: () => [],
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { startQueue } = await import("../../static/js/queue.js");
const { clearFailures, getFailures } = await import("../../static/js/notifications.js");

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

const STARTED = { running: null, queued: [], paused: false };
const answer = (status, body = STARTED) => async () => ({ ok: status < 400, status, json: async () => body });
const offline = async () => {
  throw new TypeError("Failed to fetch");
};

async function attempt(fetchStub) {
  clearFailures();
  globalThis.fetch = fetchStub;
  const started = await startQueue();
  return { started, failures: getFailures() };
}

const ok = await attempt(answer(200));
check("a started queue resolves true", ok.started === true);
check("a started queue reports nothing", ok.failures.length === 0);

const refused = await attempt(answer(500, { detail: "nope" }));
check("a refused start resolves false", refused.started === false);
check("a refused start is reported", refused.failures.length === 1, JSON.stringify(refused.failures));

const lost = await attempt(offline);
check("a start with no connection resolves false", lost.started === false);
check("a start with no connection is reported", lost.failures.length === 1);

console.log(fail ? `\n${fail} FAILED` : `\n${pass}/${pass} checks passed`);
process.exit(fail ? 1 : 0);
