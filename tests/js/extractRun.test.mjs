// Run:  node tests/js/extractRun.test.mjs

import {
  EXTRACT_OUTCOME,
  EXTRACT_PHASE,
  EXTRACT_STATE,
  SOURCE_GONE_DETAIL,
  cancelExtract,
  failureKey,
  fetchExtractView,
  filelessStems,
  followExtract,
  isExtracting,
  runLabel,
  startExtract,
} from "../../static/js/extractRun.js";
import { MAX_FAILED_POLLS } from "../../static/js/vocalSplit.js";
import { TRANSLATIONS } from "../../static/js/i18n.js";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
};

const JOB = "abc123def456";
const EXTRACT_URL = `/api/jobs/${JOB}/versions/extract`;
const EXTRACT_RUNNING_DETAIL = "more stems are already being extracted for this song";
const BODY = { from: "main", stems: ["guitar"], name: "+ Guitar" };
const FALLBACK_LOCALES = new Set(["pt-PT"]);
const IMPORT_WORDED_CAUSES = ["out-of-memory", "disk-full", "unsupported-device", "source-blocked"];
const GENERIC_KEY = "versions.extractFailed";
const LINK_DEAD_KEY = "versions.extractLinkDead";

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

const running = (phase, progress) => ({ state: EXTRACT_STATE.RUNNING, phase, progress, stems: ["guitar"], error: null });
const ended = (state, extra = {}) => ({ state, phase: EXTRACT_PHASE.FINISHING, progress: 1, stems: ["guitar"], ...extra });

{
  const { calls, io } = scriptedFetch([reply(202, { extracting: running(EXTRACT_PHASE.QUEUED, 0), versions: [] })]);
  const started = await startExtract(JOB, BODY, io);
  check("start POSTs the chosen stems", calls[0].method === "POST" && calls[0].url === EXTRACT_URL
    && JSON.parse(calls[0].body).stems.join() === "guitar");
  check("a 202 is a run started, with its view", started.outcome === EXTRACT_OUTCOME.STARTED
    && started.view.state === EXTRACT_STATE.RUNNING);

  for (const status of [200, 201]) {
    const instant = scriptedFetch([reply(status, { version: { id: "v2" }, created: status === 201 })]);
    const opened = await startExtract(JOB, BODY, instant.io);
    check(`a ${status} opened the version at once`, opened.outcome === EXTRACT_OUTCOME.OPENED
      && opened.answer.version.id === "v2");
  }

  const busy = scriptedFetch([reply(409, { detail: EXTRACT_RUNNING_DETAIL }), reply(200, running("separating", 0.4))]);
  const joined = await startExtract(JOB, BODY, busy.io);
  check("a run already going is joined", joined.outcome === EXTRACT_OUTCOME.STARTED
    && joined.view.progress === 0.4 && busy.calls[1].method === "GET");

  const gone = scriptedFetch([reply(409, { detail: SOURCE_GONE_DETAIL })]);
  const refused = await startExtract(JOB, BODY, gone.io);
  check("no kept audio is its own outcome", refused.outcome === EXTRACT_OUTCOME.SOURCE_GONE && gone.calls.length === 1);

  const full = scriptedFetch([reply(409, { detail: "this song has too many versions" })]);
  const other = await startExtract(JOB, BODY, full.io);
  check("any other refusal carries the server's detail", other.outcome === EXTRACT_OUTCOME.REFUSED
    && other.detail === "this song has too many versions");

  const offline = scriptedFetch([new TypeError("offline")]);
  check("an unreachable server is a refusal", (await startExtract(JOB, BODY, offline.io)).outcome === EXTRACT_OUTCOME.REFUSED);
}

{
  const { calls, io } = scriptedFetch([
    reply(200, running(EXTRACT_PHASE.DOWNLOADING, 0.5)),
    reply(200, running(EXTRACT_PHASE.SEPARATING, 0.3)),
    reply(200, ended(EXTRACT_STATE.DONE, { version_id: "v3" })),
  ]);
  const seen = [];
  const final = await followExtract(JOB, { onView: (v) => seen.push(v.phase), io });
  check("follow polls GET until the run ends", calls.length === 3 && calls.every((c) => c.url === EXTRACT_URL)
    && final.state === EXTRACT_STATE.DONE && final.version_id === "v3");
  check("follow reports each running view", seen.join() === "downloading,separating", seen.join());
  check("a run followed to its end is no longer extracting", !isExtracting(JOB));
}

{
  let during = false;
  const { io } = scriptedFetch([reply(200, running("separating", 0.1)), reply(200, ended(EXTRACT_STATE.CANCELLED))]);
  await followExtract(JOB, { onView: () => { during = isExtracting(JOB); }, io });
  check("a song is extracting while its run is followed", during);
}

{
  let current = true;
  const { calls, io } = scriptedFetch([reply(200, running("separating", 0.1)), reply(200, running("separating", 0.2))]);
  const final = await followExtract(JOB, { onView: () => { current = false; }, isCurrent: () => current, io });
  check("follow stops once nobody waits for it", final === null && calls.length === 1);
}

{
  const { calls, io } = scriptedFetch(Array.from({ length: MAX_FAILED_POLLS }, () => reply(500, {})));
  const final = await followExtract(JOB, { io });
  check("follow gives up after the server stops answering", calls.length === MAX_FAILED_POLLS);
  check("giving up reads as a failure with no known cause", final.state === EXTRACT_STATE.FAILED && final.error === null);
}

{
  const { io } = scriptedFetch([reply(200, { state: EXTRACT_STATE.IDLE })]);
  const final = await followExtract(JOB, { io });
  check("a run the server lost (restart) ends the follow as a failure", final.state === EXTRACT_STATE.FAILED);
}

{
  const { io } = scriptedFetch([reply(404, {})]);
  check("a view the server will not give is null", (await fetchExtractView(JOB, io)) === null);
}

{
  const { calls, io } = scriptedFetch([reply(200, ended(EXTRACT_STATE.CANCELLED))]);
  const stopped = await cancelExtract(JOB, io);
  check("stop POSTs the extraction's own cancel, not the job's", stopped
    && calls[0].method === "POST" && calls[0].url === `${EXTRACT_URL}/cancel`);
  const refused = scriptedFetch([reply(500, {})]);
  check("a refused stop says so", (await cancelExtract(JOB, refused.io)) === false);
}

{
  const t = (key, vars) => TRANSLATIONS.en[key].replace("{pct}", vars.pct);
  const label = (view) => runLabel(view, t);
  const queued = label(running(EXTRACT_PHASE.QUEUED, 0));
  check("queued waits, with no bar", queued.text === "Waiting to extract" && !queued.bar, JSON.stringify(queued));
  const separating = label(running(EXTRACT_PHASE.SEPARATING, 0.416));
  check("separating shows its percent and a bar", separating.text === "Extracting 42%" && separating.bar);
  const downloading = label(running(EXTRACT_PHASE.DOWNLOADING, 0.42));
  check("downloading shows its own percent and a bar", downloading.text === "Downloading 42%"
    && downloading.bar && downloading.progress === 0.42);
  const finishing = label(running(EXTRACT_PHASE.FINISHING, 0.3));
  check("finishing has a full bar", finishing.text === "Finishing…" && finishing.bar && finishing.progress === 1);
}

{
  const failedIn = (phase, error) => failureKey(ended(EXTRACT_STATE.FAILED, { phase, error }));
  const keys = IMPORT_WORDED_CAUSES.map((cause) => failedIn(EXTRACT_PHASE.SEPARATING, cause));
  check("each cause the import words is worded as the import does", keys.every((k) => k.startsWith("importFail.reason.")), keys.join());
  check("a download that failed says the link no longer works",
    ["unknown", "source-unavailable"].every((c) => failedIn(EXTRACT_PHASE.DOWNLOADING, c) === LINK_DEAD_KEY));
  check("a full disk while downloading keeps the import's sentence",
    failedIn(EXTRACT_PHASE.DOWNLOADING, "disk-full") === "importFail.reason.diskFull");
  check("an unworded cause while downloading is generic", failedIn(EXTRACT_PHASE.DOWNLOADING, "no-output") === GENERIC_KEY);
  check("a removed video says the link no longer works", failedIn(EXTRACT_PHASE.SEPARATING, "source-unavailable") === LINK_DEAD_KEY);
  check("a blocked download keeps the import's sentence",
    failedIn(EXTRACT_PHASE.DOWNLOADING, "source-blocked") === "importFail.reason.sourceBlocked");
  check("too many versions says so", failedIn(EXTRACT_PHASE.FINISHING, "too-many-versions") === "versions.tooMany");
  check("unknown and no-output read as the generic sentence",
    ["unknown", "no-output", "bad-input"].every((c) => failedIn(EXTRACT_PHASE.SEPARATING, c) === GENERIC_KEY));
  check("a run the server stopped answering about is generic", failureKey({ state: EXTRACT_STATE.FAILED, error: null }) === GENERIC_KEY);
}

{
  const versions = { versions: [], missing_files: ["guitar", "piano"] };
  check("stems the server has no file for are named", filelessStems(versions, ["bass", "guitar"]).join() === "guitar");
  check("a payload without missing_files names none", filelessStems({ versions: [] }, ["guitar"]).length === 0);
}

{
  const keys = [
    GENERIC_KEY, LINK_DEAD_KEY, "versions.tooMany", "versions.extractWaiting", "versions.extracting", "versions.extractDownloading",
    "versions.extractFinishing", "versions.extractStop", "versions.extractSlowHint", "versions.sourceGone",
    "notifKind.extractFailed",
  ];
  for (const [code, table] of Object.entries(TRANSLATIONS)) {
    if (FALLBACK_LOCALES.has(code)) continue;
    const missing = keys.filter((k) => !(k in table));
    check(`${code} has every extract sentence`, missing.length === 0, missing.join());
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
