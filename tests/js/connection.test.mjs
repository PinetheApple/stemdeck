// The monitor counts network-level failures of the app's own /api requests
// and flips to offline after a few in a row; any HTTP answer, even an error
// status, means the server is there.
//
// Run:  node tests/js/connection.test.mjs

import {
  createConnectionMonitor,
  isApiRequest,
  FAILURES_BEFORE_OFFLINE,
  HEALTH_URL,
  PROBE_INTERVAL_MS,
} from "../../static/js/connection.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
};

const ORIGIN = "http://127.0.0.1:8000";
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const networkError = () => new TypeError("Failed to fetch");
const abortError = () => Object.assign(new Error("aborted"), { name: "AbortError" });

/** A monitor over a scripted fetch: each call takes the next queued outcome. */
function harness() {
  const outcomes = [];
  const calls = [];
  const changes = [];
  const restored = [];
  const timers = [];
  const baseFetch = (input) => {
    calls.push(String(input?.url ?? input));
    const next = outcomes.shift() ?? { status: 200 };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const monitor = createConnectionMonitor({
    baseFetch,
    origin: ORIGIN,
    onChange: (offline) => changes.push(offline),
    onRestored: () => restored.push(true),
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  const failTimes = async (n, error = networkError) => {
    for (let i = 0; i < n; i++) {
      outcomes.push(error());
      await monitor.fetch("/api/jobs").catch(() => {});
    }
    await settle();
  };
  return { outcomes, calls, changes, restored, timers, monitor, failTimes };
}

// --------------------------------------------------------------------------
// Which requests count
// --------------------------------------------------------------------------

check("a relative /api path counts", isApiRequest("/api/jobs", ORIGIN));
check("an absolute same-origin /api URL counts", isApiRequest(`${ORIGIN}/api/health`, ORIGIN));
check("a URL object counts", isApiRequest(new URL("/api/x", ORIGIN), ORIGIN));
check("a Request-like object counts", isApiRequest({ url: `${ORIGIN}/api/x` }, ORIGIN));
check("a static asset does not count", !isApiRequest("/static/js/main.js", ORIGIN));
check("another origin's /api does not count", !isApiRequest("https://api.github.com/api/x", ORIGIN));
check("a path merely starting with api does not count", !isApiRequest("/apiary", ORIGIN));
check("an unparseable URL does not count", !isApiRequest("http://[bad", ORIGIN));

{
  const h = harness();
  const error = networkError();
  h.outcomes.push(error);
  let pending = null;
  let threw = null;
  try { pending = h.monitor.fetch("http://[bad"); } catch (e) { threw = e; }
  check("an unparseable URL does not throw synchronously", threw === null, String(threw));
  const caught = await pending.catch((e) => e);
  await settle();
  check("an unparseable URL goes straight to fetch", caught === error && h.calls.at(-1) === "http://[bad");
  check("an unparseable URL is not monitored", h.timers.length === 0);
}

// --------------------------------------------------------------------------
// Threshold and recovery
// --------------------------------------------------------------------------

{
  const h = harness();
  await h.failTimes(FAILURES_BEFORE_OFFLINE - 1);
  check("below the threshold the app is still online", !h.monitor.isOffline() && h.changes.length === 0);
  await h.failTimes(1);
  check("the threshold-th failure in a row goes offline", h.monitor.isOffline());
  check("going offline is announced once", JSON.stringify(h.changes) === "[true]", JSON.stringify(h.changes));
  await h.failTimes(2);
  check("further failures do not re-announce", h.changes.length === 1);

  h.outcomes.push({ status: 200 });
  await h.monitor.fetch("/api/jobs");
  await settle();
  check("any answer recovers", !h.monitor.isOffline());
  check("recovery is announced", JSON.stringify(h.changes) === "[true,false]", JSON.stringify(h.changes));
}

{
  const h = harness();
  await h.failTimes(FAILURES_BEFORE_OFFLINE - 1);
  h.outcomes.push({ status: 500 });
  await h.monitor.fetch("/api/jobs");
  await settle();
  await h.failTimes(FAILURES_BEFORE_OFFLINE - 1);
  check("an error status resets the count: the server answered", !h.monitor.isOffline());
}

{
  const h = harness();
  await h.failTimes(FAILURES_BEFORE_OFFLINE + 1, abortError);
  check("an aborted request is not a lost server", !h.monitor.isOffline() && h.timers.length === 0);
}

{
  const h = harness();
  for (let i = 0; i < FAILURES_BEFORE_OFFLINE + 1; i++) {
    h.outcomes.push(networkError());
    await h.monitor.fetch("https://api.github.com/repos/x").catch(() => {});
  }
  await settle();
  check("failures outside /api are ignored", !h.monitor.isOffline() && h.timers.length === 0);
}

// --------------------------------------------------------------------------
// Transparency: callers see exactly what fetch gave them
// --------------------------------------------------------------------------

{
  const h = harness();
  const response = { status: 404, marker: "same" };
  h.outcomes.push(response);
  const got = await h.monitor.fetch("/api/jobs/x");
  check("the response object is passed through", got === response);

  const error = networkError();
  h.outcomes.push(error);
  let caught = null;
  try { await h.monitor.fetch("/api/jobs/x"); } catch (e) { caught = e; }
  check("the rejection is passed through unchanged", caught === error);
}

// --------------------------------------------------------------------------
// Probing: recovery is noticed without the user having to act
// --------------------------------------------------------------------------

{
  const h = harness();
  await h.failTimes(1);
  check("a failure schedules a health probe", h.timers.length === 1 && h.timers[0].ms === PROBE_INTERVAL_MS);
  await h.failTimes(1);
  check("only one probe is pending at a time", h.timers.length === 1);

  h.outcomes.push(networkError());
  h.timers.shift().fn();
  await settle();
  check("the probe asks the health endpoint", h.calls.at(-1) === HEALTH_URL, h.calls.at(-1));
  check("a failed probe counts toward offline", h.monitor.isOffline());
  check("a failed probe schedules the next one", h.timers.length === 1);

  h.outcomes.push({ status: 200 });
  h.timers.shift().fn();
  await settle();
  check("a probe that gets an answer clears offline", !h.monitor.isOffline());
  check("probing stops once the server answers", h.timers.length === 0);
}

{
  const h = harness();
  await h.failTimes(1);
  h.outcomes.push({ status: 200 });
  await h.monitor.fetch("/api/jobs");
  await settle();
  const before = h.calls.length;
  h.timers.shift().fn();
  await settle();
  check("a probe due after recovery does not fire", h.calls.length === before);
}

// --------------------------------------------------------------------------
// Restored: an answer after unanswered requests, so lost saves can go again
// --------------------------------------------------------------------------

{
  const h = harness();
  await h.monitor.fetch("/api/jobs");
  await settle();
  check("an answer with nothing unanswered before it restores nothing", h.restored.length === 0);
  await h.failTimes(1);
  check("a failure alone restores nothing", h.restored.length === 0);
  await h.monitor.fetch("/api/jobs");
  await settle();
  check("the first answer after a failure is a restored connection", h.restored.length === 1);
  await h.monitor.fetch("/api/jobs");
  await settle();
  check("later answers restore nothing more", h.restored.length === 1);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
