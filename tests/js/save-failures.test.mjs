// A save failure already on the notification card is not written again when it repeats.
//
// Run:  node tests/js/save-failures.test.mjs

globalThis.window = {};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.document = { getElementById: () => null, querySelectorAll: () => [] };

const { clearFailures, getFailures } = await import("../../static/js/notifications.js");
const { notifySaveFailure, SAVE_KIND, SAVE_LOST, SAVE_REFUSED } = await import("../../static/js/saveFailures.js");

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
};

const SONG = "aaaaaaaaaaaa";

clearFailures();
notifySaveFailure(SAVE_KIND.sections, SAVE_LOST, SONG);
const first = getFailures()[0];
notifySaveFailure(SAVE_KIND.sections, SAVE_LOST, SONG);
check("the same failure again leaves its card as it was", getFailures().length === 1 && getFailures()[0] === first);

notifySaveFailure(SAVE_KIND.sections, SAVE_REFUSED, SONG);
check("a different failure of the same save replaces its card", getFailures().length === 1 && getFailures()[0] !== first);

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
