// The lead/backing vocal split's client side: the stored choice, starting and
// following a split, and a sentence of its own for every failure the server names.
//
// Run:  node tests/js/vocal-split.test.mjs

import {
  SPLIT_STATE,
  SPLIT_CHOICE,
  MAX_FAILED_POLLS,
  failureKey,
  wantsAutoSplit,
  storeSplitChoice,
  startSplit,
  fetchSplitView,
  followSplit,
  cancelSplit,
  resumeRequestedSplits,
} from "../../static/js/vocalSplit.js";
import { TRANSLATIONS } from "../../static/js/i18n.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
};

const JOB = "abc123def456";
// app/core/models.py VOCAL_SPLIT_FAILED_*; worker_failed is "anything else".
const FAILURE_CODES = [
  "model_missing", "out_of_memory", "unsupported_device", "disk_full",
  "stalled", "no_vocals", "no_output",
];
const CATCH_ALL_CODE = "worker_failed";
const GENERIC_KEY = failureKey(null);
// Tables that fall back to another for any key they leave out.
const FALLBACK_LOCALES = new Set(["pt-PT"]);

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A fetch that answers from `answers` in order and records every call. */
function scriptedFetch(answers) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next ?? reply(500, {});
  };
  return { calls, io: { fetch: fetchFn, wait: async () => {} } };
}

const running = (phase, progress) => ({ state: SPLIT_STATE.RUNNING, choice: "split", error: null, phase, progress });
const ended = (state, error = null) => ({ state, choice: "split", error });
const doneJob = (overrides = {}) => ({
  job_id: JOB,
  status: "done",
  stems: [{ name: "vocals", url: "/v.wav" }, { name: "drums", url: "/d.wav" }],
  vocal_split: SPLIT_STATE.NONE,
  vocal_split_choice: SPLIT_CHOICE.SPLIT,
  ...overrides,
});

{
  const keys = FAILURE_CODES.map(failureKey);
  check("every failure code has its own sentence", new Set(keys).size === FAILURE_CODES.length, keys.join());
  check("no failure code falls back to the generic sentence", !keys.includes(GENERIC_KEY));
  check("an unknown code reads as the generic sentence", failureKey("something_new") === GENERIC_KEY);
  check("a failure of no named kind reads as the generic sentence", failureKey(CATCH_ALL_CODE) === GENERIC_KEY);
  for (const [code, table] of Object.entries(TRANSLATIONS)) {
    if (FALLBACK_LOCALES.has(code)) continue;
    const missing = [...keys, GENERIC_KEY].filter((k) => !(k in table));
    check(`${code} has every failure sentence`, missing.length === 0, missing.join());
  }
}

{
  check("a done song that asked for the split wants it", wantsAutoSplit(doneJob()));
  check("Combined does not", !wantsAutoSplit(doneJob({ vocal_split_choice: SPLIT_CHOICE.COMBINED })));
  check("an unfinished song does not", !wantsAutoSplit(doneJob({ status: "separating" })));
  check("a split already done does not", !wantsAutoSplit(doneJob({ vocal_split: SPLIT_STATE.DONE })));
  check("a failed split waits for Retry", !wantsAutoSplit(doneJob({ vocal_split: SPLIT_STATE.ERROR })));
  check("a cancelled split stays cancelled", !wantsAutoSplit(doneJob({ vocal_split: SPLIT_STATE.CANCELLED })));
  check("a song with no vocals stem does not", !wantsAutoSplit(doneJob({ stems: [{ name: "drums" }] })));
}

{
  const { calls, io } = scriptedFetch([reply(200, doneJob())]);
  const stored = await storeSplitChoice(JOB, SPLIT_CHOICE.SPLIT, io);
  check("storing the choice says it was stored", stored === true);
  check("the choice is PUT to the job", calls[0].method === "PUT" && calls[0].url === `/api/jobs/${JOB}/vocal-split/choice`);
  check("the body names the choice", JSON.parse(calls[0].body).choice === "split");
  const refused = scriptedFetch([reply(422, {})]);
  check("a refused choice says so", (await storeSplitChoice(JOB, "bogus", refused.io)) === false);
  const offline = scriptedFetch([new TypeError("offline")]);
  check("an unreachable server says so", (await storeSplitChoice(JOB, SPLIT_CHOICE.SPLIT, offline.io)) === false);
}

{
  const { calls, io } = scriptedFetch([reply(202, running("queued", 0))]);
  const view = await startSplit(JOB, io);
  check("start POSTs the split", calls[0].method === "POST" && calls[0].url === `/api/jobs/${JOB}/vocal-split`);
  check("start answers the running view", view.state === SPLIT_STATE.RUNNING);

  const busy = scriptedFetch([reply(409, { detail: "vocal split already running" }), reply(200, running("splitting", 0.3))]);
  const joined = await startSplit(JOB, busy.io);
  check("a split already under way is joined", joined.state === SPLIT_STATE.RUNNING && busy.calls[1].method === "GET");

  const noVocals = scriptedFetch([reply(409, { detail: "no vocals stem" }), reply(200, ended(SPLIT_STATE.NONE))]);
  let threw = null;
  try { await startSplit(JOB, noVocals.io); } catch (err) { threw = err; }
  check("a refusal with nothing running is an error", threw instanceof Error);

  const broken = scriptedFetch([reply(500, {})]);
  threw = null;
  try { await startSplit(JOB, broken.io); } catch (err) { threw = err; }
  check("a server error is an error", threw instanceof Error);
}

{
  const { calls, io } = scriptedFetch([
    reply(200, running("queued", 0)),
    reply(200, running("splitting", 0.5)),
    reply(200, ended(SPLIT_STATE.DONE)),
  ]);
  const seen = [];
  const final = await followSplit(JOB, { onView: (v) => seen.push(v.phase), io });
  check("follow polls until the split ends", calls.length === 3 && final.state === SPLIT_STATE.DONE);
  check("follow reports each running view", seen.join() === "queued,splitting", seen.join());

  const failed = scriptedFetch([reply(200, ended(SPLIT_STATE.ERROR, "out_of_memory"))]);
  const failure = await followSplit(JOB, { io: failed.io });
  check("follow ends on the failure with its code", failure.state === SPLIT_STATE.ERROR && failure.error === "out_of_memory");
}

{
  let current = true;
  const { calls, io } = scriptedFetch([reply(200, running("splitting", 0.1)), reply(200, running("splitting", 0.2))]);
  const final = await followSplit(JOB, { onView: () => { current = false; }, isCurrent: () => current, io });
  check("follow stops once the view moved on", final === null && calls.length === 1);
}

{
  const answers = Array.from({ length: MAX_FAILED_POLLS }, () => reply(500, {}));
  const { calls, io } = scriptedFetch(answers);
  const final = await followSplit(JOB, { io });
  check("follow gives up after the server stops answering", calls.length === MAX_FAILED_POLLS);
  check("giving up reads as a failure with no known cause", final.state === SPLIT_STATE.ERROR && final.error === null);
}

{
  const { io } = scriptedFetch([reply(404, {})]);
  check("a view the server will not give is null", (await fetchSplitView(JOB, io)) === null);
}

{
  const { calls, io } = scriptedFetch([reply(200, { status: "done" })]);
  const cancelled = await cancelSplit(JOB, io);
  check("cancel goes through the job's own cancel", cancelled && calls[0].method === "POST" && calls[0].url === `/api/jobs/${JOB}/cancel`);
  const refused = scriptedFetch([reply(500, {})]);
  check("a refused cancel says so", (await cancelSplit(JOB, refused.io)) === false);
}

{
  const other = "0123456789ab";
  const jobs = [doneJob(), doneJob({ job_id: other, vocal_split_choice: SPLIT_CHOICE.COMBINED })];
  const { calls, io } = scriptedFetch([reply(200, jobs), reply(202, running("queued", 0))]);
  const started = await resumeRequestedSplits(io);
  const posts = calls.filter((c) => c.method === "POST");
  check("resume starts only the songs that asked for a split", posts.length === 1 && posts[0].url.includes(JOB));
  check("resume names what it started", started.join() === JOB);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
