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
const {
  notifySaveFailure,
  refusalOf,
  UnconfirmedSaves,
  RESET_FAILED,
  SAVE_FOLDER_MOVING,
  SAVE_KIND,
  SAVE_LOST,
  SAVE_REFUSED,
} = await import("../../static/js/saveFailures.js");
const { t } = await import("../../static/js/i18n.js");
const { HTTP_CONFLICT } = await import("../../static/js/lyricsTranscribe.js");
const { EDIT_FOLDER_MOVING_DETAIL, FOLDER_MOVING_KEY } = await import("../../static/js/folderMoving.js");
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

{
  const answer = (detail) => new Response(JSON.stringify({ detail }), { status: HTTP_CONFLICT });
  check("a save refused for the move is told apart", (await refusalOf(answer(EDIT_FOLDER_MOVING_DETAIL))) === SAVE_FOLDER_MOVING);
  check("any other refusal stays a refusal", (await refusalOf(answer("job not ready"))) === SAVE_REFUSED);
  check("a reset keeps its own failure", (await refusalOf(answer("x"), RESET_FAILED)) === RESET_FAILED);
  check("no answer at all keeps its own failure", (await refusalOf(new TypeError("unreachable"), RESET_FAILED)) === RESET_FAILED);

  for (const kind of Object.values(SAVE_KIND)) {
    clearFailures();
    const saves = new UnconfirmedSaves({ kind, resend: () => {} });
    saves.set(SONG, "edit");
    saves.refuse(SONG, "edit", SAVE_FOLDER_MOVING);
    check(`a ${kind} save refused for the move says to wait for it`, getFailures()[0]?.message === t(FOLDER_MOVING_KEY));
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
