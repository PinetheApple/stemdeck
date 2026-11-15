// No DOM, so the node tests import it.

import { HTTP_CONFLICT } from "./lyricsTranscribe.js";
import { failureReasonKey } from "./importSource.js";
import { UNREACHABLE_VIEW, pollUntilEnded } from "./vocalSplit.js";

export const EXTRACT_STATE = Object.freeze({
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
  IDLE: "idle",
});
export const EXTRACT_PHASE = Object.freeze({
  QUEUED: "queued",
  DOWNLOADING: "downloading",
  SEPARATING: "separating",
  FINISHING: "finishing",
});
export const EXTRACT_OUTCOME = Object.freeze({
  OPENED: "opened",
  STARTED: "started",
  SOURCE_GONE: "source-gone",
  REFUSED: "refused",
});
const LOST_VIEW = Object.freeze({ state: EXTRACT_STATE.FAILED, error: null });

// app/api/versions.py SOURCE_GONE and EXTRACT_RUNNING.
export const SOURCE_GONE_DETAIL = "this song's original audio is not kept; import it again to get these stems";
const EXTRACT_RUNNING_DETAIL = "more stems are already being extracted for this song";
const HTTP_ACCEPTED = 202;
const FULL = 1;
const PERCENT = 100;

const SOURCE_BLOCKED = "source-blocked";
const SOURCE_UNAVAILABLE = "source-unavailable";
const TOO_MANY_VERSIONS = "too-many-versions";
// classify_failure causes whose import sentence also reads right for this run.
const IMPORT_WORDED_CAUSES = new Set(["out-of-memory", "disk-full", "unsupported-device", SOURCE_BLOCKED]);
const GENERIC_FAILURE_KEY = "versions.extractFailed";
const LINK_DEAD_KEY = "versions.extractLinkDead";
const TOO_MANY_KEY = "versions.tooMany";
const LABEL_KEYS = {
  [EXTRACT_PHASE.QUEUED]: "versions.extractWaiting",
  [EXTRACT_PHASE.DOWNLOADING]: "versions.extractDownloading",
  [EXTRACT_PHASE.FINISHING]: "versions.extractFinishing",
};
const SEPARATING_KEY = "versions.extracting";

const JSON_HEADERS = { "Content-Type": "application/json" };
const DEFAULT_IO = Object.freeze({
  fetch: (...args) => fetch(...args),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const following = new Set();

const extractUrl = (jobId) => `/api/jobs/${encodeURIComponent(jobId)}/versions/extract`;

/** The i18n key of the sentence that says why a failed run's view failed. */
export function failureKey({ error, phase }) {
  if (error === TOO_MANY_VERSIONS) return TOO_MANY_KEY;
  const downloadFailed = phase === EXTRACT_PHASE.DOWNLOADING && error !== SOURCE_BLOCKED;
  if (downloadFailed || error === SOURCE_UNAVAILABLE) return LINK_DEAD_KEY;
  return IMPORT_WORDED_CAUSES.has(error) ? failureReasonKey(error) : GENERIC_FAILURE_KEY;
}

/** What a running view shows: its words, whether a bar goes under them, and how full. */
export function runLabel(view, t) {
  const phase = view?.phase ?? EXTRACT_PHASE.SEPARATING;
  const progress = phase === EXTRACT_PHASE.FINISHING ? FULL : Number(view?.progress) || 0;
  const pct = Math.round(progress * PERCENT);
  const text = t(LABEL_KEYS[phase] ?? SEPARATING_KEY, { pct });
  return { text, bar: phase !== EXTRACT_PHASE.QUEUED, progress };
}

/** Of `stems`, those the song's versions payload says have no file. */
export function filelessStems(versionsState, stems) {
  const missing = new Set(versionsState?.missing_files ?? []);
  return stems.filter((name) => missing.has(name));
}

export const isExtracting = (jobId) => following.has(jobId);

async function readJson(res) {
  return res.json().catch(() => null);
}

/** Where the song's run stands on the server, or null when it gave none. */
export async function fetchExtractView(jobId, io = DEFAULT_IO) {
  try {
    const res = await io.fetch(extractUrl(jobId), { cache: "no-store" });
    if (res.ok) return await res.json();
    console.warn("[extractRun] state refused", res.status);
  } catch (err) {
    console.warn("[extractRun] state not read", err);
  }
  return null;
}

async function refusal(jobId, detail, io) {
  if (detail === SOURCE_GONE_DETAIL) return { outcome: EXTRACT_OUTCOME.SOURCE_GONE };
  if (detail === EXTRACT_RUNNING_DETAIL) {
    const view = await fetchExtractView(jobId, io);
    if (view?.state === EXTRACT_STATE.RUNNING) return { outcome: EXTRACT_OUTCOME.STARTED, view };
  }
  return { outcome: EXTRACT_OUTCOME.REFUSED, detail };
}

/**
 * Ask for the version with `body.stems` added: OPENED when the files were all there,
 * STARTED when they are being made, else SOURCE_GONE or REFUSED with the server's detail.
 */
export async function startExtract(jobId, body, io = DEFAULT_IO) {
  let res;
  try {
    res = await io.fetch(extractUrl(jobId), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  } catch (err) {
    console.warn("[extractRun] not started", err);
    return { outcome: EXTRACT_OUTCOME.REFUSED, detail: null };
  }
  const answer = await readJson(res);
  if (res.status === HTTP_ACCEPTED) return { outcome: EXTRACT_OUTCOME.STARTED, view: answer?.extracting, answer };
  if (res.ok) return { outcome: EXTRACT_OUTCOME.OPENED, answer };
  if (res.status === HTTP_CONFLICT) return refusal(jobId, answer?.detail, io);
  return { outcome: EXTRACT_OUTCOME.REFUSED, detail: answer?.detail ?? null };
}

const isExtractEnded = (view) => view.state !== EXTRACT_STATE.RUNNING;

function settled(view) {
  return view === UNREACHABLE_VIEW || view.state === EXTRACT_STATE.IDLE ? LOST_VIEW : view;
}

/**
 * Poll until the run ends and answer its last view, or null once `isCurrent()`
 * says nobody waits for it. A run the server no longer knows ended in failure.
 */
export async function followExtract(
  jobId,
  { onView = () => {}, isCurrent = () => true, io = DEFAULT_IO } = {},
) {
  following.add(jobId);
  try {
    const final = await pollUntilEnded(jobId, {
      onView,
      isCurrent,
      io,
      fetchView: fetchExtractView,
      ended: isExtractEnded,
    });
    return final && settled(final);
  } finally {
    following.delete(jobId);
  }
}

/** Stop only this run; the next poll says "cancelled". */
export async function cancelExtract(jobId, io = DEFAULT_IO) {
  try {
    const res = await io.fetch(`${extractUrl(jobId)}/cancel`, { method: "POST" });
    if (res.ok) return true;
    console.warn("[extractRun] stop refused", res.status);
  } catch (err) {
    console.warn("[extractRun] stop failed", err);
  }
  return false;
}
