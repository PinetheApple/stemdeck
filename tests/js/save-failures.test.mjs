// A lost save goes again on its own once the server answers, and a repeated failure leaves
// its notification card as it was.
//
// Run:  node tests/js/save-failures.test.mjs

const ORIGIN = "http://127.0.0.1:8000";
const timers = [];
const outcomes = [];
const page = new EventTarget();
page.getElementById = () => null;
page.querySelectorAll = () => [];
globalThis.document = page;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
globalThis.window = {
  location: { origin: ORIGIN },
  setTimeout: (fn) => timers.push(fn),
  fetch: () => {
    const next = outcomes.shift() ?? { status: 200 };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
};

const { initConnection } = await import("../../static/js/connection.js");
const { clearFailures, getFailures } = await import("../../static/js/notifications.js");
const { notifySaveFailure, UnconfirmedSaves, SAVE_KIND, SAVE_LOST, SAVE_REFUSED } = await import(
  "../../static/js/saveFailures.js"
);
initConnection();

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`); }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const SONG = "aaaaaaaaaaaa";
const OTHER_SONG = "bbbbbbbbbbbb";
const LATER_SONG = "cccccccccccc";

clearFailures();
notifySaveFailure(SAVE_KIND.sections, SAVE_LOST, SONG);
const first = getFailures()[0];
notifySaveFailure(SAVE_KIND.sections, SAVE_LOST, SONG);
check("the same failure again leaves its card as it was", getFailures().length === 1 && getFailures()[0] === first);
notifySaveFailure(SAVE_KIND.sections, SAVE_REFUSED, SONG);
check("a different failure of the same save replaces its card", getFailures().length === 1 && getFailures()[0] !== first);

{
  const resent = [];
  const saves = new UnconfirmedSaves({ kind: SAVE_KIND.sections, resend: (id, entry) => resent.push(entry) });
  saves.set(OTHER_SONG, "edit");
  outcomes.push(new TypeError("unreachable"));
  saves.lose(OTHER_SONG, "edit");
  await settle();
  check("a lost save whose health check goes unanswered is not sent yet", resent.length === 0);
  timers.shift()();
  await settle();
  check("the next answered health check sends the lost save again", resent.length === 1);
}

{
  const resent = [];
  const saves = new UnconfirmedSaves({ kind: SAVE_KIND.sections, resend: (id, entry) => resent.push(entry) });
  saves.set(LATER_SONG, "same");
  saves.lose(LATER_SONG, "same");
  await settle();
  check("a lost save goes again once the server answers", resent.length === 1);
  saves.confirm(LATER_SONG, "same");
  saves.set(LATER_SONG, "same");
  saves.lose(LATER_SONG, "same");
  await settle();
  check("a later lost save with the same content goes again too", resent.length === 2);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
