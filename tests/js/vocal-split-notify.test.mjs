// A split that ran on its own and failed is reported in the notification
// centre, under a label of its own and with the cause's sentence.
//
// Run:  node tests/js/vocal-split-notify.test.mjs

globalThis.window = {};
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };

const { clearFailures, getFailures, buildReportUrl } = await import("../../static/js/notifications.js");
const { reportSplitFailure, SPLIT_FAILURE_KIND } = await import("../../static/js/vocalSplitNotify.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
};

const JOB = "abc123def456";
const OUT_OF_MEMORY = "There was not enough memory to split the vocals. Close other apps, then try again.";
const GENERIC = "The vocals could not be split. Try again.";
const titleOf = (record) => new URL(buildReportUrl(record)).searchParams.get("title");

{
  clearFailures();
  const record = reportSplitFailure(JOB, { state: "error", error: "out_of_memory" });
  check("the failure is recorded under its own kind", record.kind === SPLIT_FAILURE_KIND, record.kind);
  check("its report is titled with the label and the cause", titleOf(record) === "[Bug]: Vocal split failed - out_of_memory", titleOf(record));
  check("its message is the cause's sentence", record.message === OUT_OF_MEMORY, record.message);
  check("it carries the cause code", record.cause === "out_of_memory", record.cause);
  check("it is tied to the song", record.context.jobId === JOB);
}

{
  clearFailures();
  const record = reportSplitFailure(JOB, { state: "error", error: null });
  check("a failure with no known cause reads as the generic sentence", record.message === GENERIC, record.message);
  check("and has no cause", record.cause === null);
}

{
  clearFailures();
  reportSplitFailure(JOB, { state: "error", error: "stalled" });
  reportSplitFailure(JOB, { state: "error", error: "stalled" });
  check("a second sighting of the same song's failure is one card", getFailures().length === 1, String(getFailures().length));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
