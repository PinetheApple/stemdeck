// restoreFailures puts back the cards a refused Trash dismissed: the same
// records, in time order, never twice.
//
// Run:  node tests/js/notifications-restore.test.mjs

globalThis.window = {};
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };

const { test } = await import("node:test");
const assert = (await import("node:assert/strict")).default;
const {
  notifyFailure,
  dismissFailuresByJobId,
  restoreFailures,
  clearFailures,
  getFailures,
} = await import("../../static/js/notifications.js");

const JOB = "job-binned";
// Cards are ordered by when they were shown; each one here is a millisecond apart.
let now = 1_000;
Date.now = () => ++now;
const ids = () => getFailures().map((f) => f.id);

test("dismissed cards come back as they were, in order", () => {
  clearFailures();
  notifyFailure({ kind: "import", message: "older", context: { jobId: JOB } });
  notifyFailure({ kind: "update", message: "unrelated" });
  notifyFailure({ kind: "playback", message: "newer", context: { jobId: JOB } });
  const before = getFailures().map((f) => ({ ...f }));
  const dismissed = getFailures().filter((f) => f.context?.jobId === JOB);

  dismissFailuresByJobId(JOB);
  assert.equal(getFailures().length, 1);
  restoreFailures(dismissed);

  assert.deepEqual(getFailures(), before);
});

test("a card still showing is not added twice", () => {
  clearFailures();
  notifyFailure({ kind: "import", message: "shown", context: { jobId: JOB } });
  const shown = [...getFailures()];

  restoreFailures(shown);

  assert.deepEqual(ids(), shown.map((f) => f.id));
});
