// A song's lead/backing vocal split on the server: the stored choice, starting
// or retrying it, following it to the end, and the message key for each failure.
// No DOM and no i18n, so the desktop and the phone UI can both use it.

export const SPLIT_STATE = Object.freeze({
  NONE: "none",
  RUNNING: "running",
  DONE: "done",
  ERROR: "error",
  CANCELLED: "cancelled",
});
export const SPLIT_CHOICE = Object.freeze({ COMBINED: "combined", SPLIT: "split" });
export const SPLIT_PHASE = Object.freeze({ QUEUED: "queued", SPLITTING: "splitting" });
export const POLL_MS = 1000;
// Polls in a row that got no answer before the split is given up for failed.
export const MAX_FAILED_POLLS = 3;

const JOB_DONE = "done";
const VOCALS_STEM = "vocals";
const HTTP_CONFLICT = 409;
const JSON_HEADERS = { "Content-Type": "application/json" };
const UNREACHABLE_VIEW = Object.freeze({ state: SPLIT_STATE.ERROR, error: null });
// app/core/models.py VOCAL_SPLIT_FAILED_*
const FAILURE_KEYS = {
  model_missing: "vocalSplit.failed.modelMissing",
  out_of_memory: "vocalSplit.failed.outOfMemory",
  unsupported_device: "vocalSplit.failed.unsupportedDevice",
  disk_full: "vocalSplit.failed.diskFull",
  stalled: "vocalSplit.failed.stalled",
  no_vocals: "vocalSplit.failed.noVocals",
  no_output: "vocalSplit.failed.noOutput",
  worker_failed: "vocalSplit.failed.generic",
};
const GENERIC_FAILURE_KEY = "vocalSplit.failed.generic";

const DEFAULT_IO = Object.freeze({
  fetch: (...args) => fetch(...args),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

const jobUrl = (jobId) => `/api/jobs/${encodeURIComponent(jobId)}`;
const splitUrl = (jobId) => `${jobUrl(jobId)}/vocal-split`;

/** The i18n key of the sentence that says why a split failed. */
export function failureKey(code) {
  return FAILURE_KEYS[code] ?? GENERIC_FAILURE_KEY;
}

export const hasVocalsStem = (job) => (job?.stems || []).some((stem) => stem.name === VOCALS_STEM);

/** A finished song whose stored choice asks for a split nobody has started yet. */
export function wantsAutoSplit(job) {
  return job?.status === JOB_DONE
    && job.vocal_split_choice === SPLIT_CHOICE.SPLIT
    && job.vocal_split === SPLIT_STATE.NONE
    && hasVocalsStem(job);
}

/** Store Combined or Lead + Backing with the song. True once the server has it. */
export async function storeSplitChoice(jobId, choice, io = DEFAULT_IO) {
  try {
    const res = await io.fetch(`${splitUrl(jobId)}/choice`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ choice }),
    });
    if (res.ok) return true;
    console.warn("[vocalSplit] choice refused", res.status);
  } catch (err) {
    console.warn("[vocalSplit] choice not stored", err);
  }
  return false;
}

/** The split's state on the server, or null when it gave none. */
export async function fetchSplitView(jobId, io = DEFAULT_IO) {
  try {
    const res = await io.fetch(splitUrl(jobId), { cache: "no-store" });
    if (res.ok) return await res.json();
    console.warn("[vocalSplit] state refused", res.status);
  } catch (err) {
    console.warn("[vocalSplit] state not read", err);
  }
  return null;
}

/** Start (or retry) the split; a split already under way is joined. Throws when refused. */
export async function startSplit(jobId, io = DEFAULT_IO) {
  const res = await io.fetch(splitUrl(jobId), { method: "POST" });
  if (res.ok) return res.json();
  if (res.status === HTTP_CONFLICT) {
    const view = await fetchSplitView(jobId, io);
    if (view?.state === SPLIT_STATE.RUNNING) return view;
  }
  throw new Error(`vocal split refused: HTTP ${res.status}`);
}

/**
 * Poll until the split ends and answer its last view, or null once
 * `isCurrent()` says nobody is waiting for it any more.
 */
export async function followSplit(jobId, { onView = () => {}, isCurrent = () => true, io = DEFAULT_IO } = {}) {
  let failures = 0;
  while (isCurrent()) {
    const view = await fetchSplitView(jobId, io);
    if (!isCurrent()) return null;
    if (!view) {
      failures += 1;
      if (failures >= MAX_FAILED_POLLS) return UNREACHABLE_VIEW;
    } else if (view.state !== SPLIT_STATE.RUNNING) {
      return view;
    } else {
      failures = 0;
      onView(view);
    }
    await io.wait(POLL_MS);
  }
  return null;
}

/** The job's own cancel stops its split; the next poll says "cancelled". */
export async function cancelSplit(jobId, io = DEFAULT_IO) {
  try {
    const res = await io.fetch(`${jobUrl(jobId)}/cancel`, { method: "POST" });
    if (res.ok) return true;
    console.warn("[vocalSplit] cancel refused", res.status);
  } catch (err) {
    console.warn("[vocalSplit] cancel failed", err);
  }
  return false;
}
