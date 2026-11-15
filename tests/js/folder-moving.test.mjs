// A write refused while StemData moves is told apart and worded in every language.
//
// Run:  node tests/js/folder-moving.test.mjs

import { readFileSync } from "node:fs";

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const { HTTP_CONFLICT } = await import("../../static/js/lyricsTranscribe.js");
const {
  EDIT_FOLDER_MOVING_DETAIL,
  FOLDER_MOVING_DETAIL,
  FOLDER_MOVING_KEY,
  SPLIT_FOLDER_MOVING_DETAIL,
  isFolderMoving,
  refusalKey,
  refusedForFolderMove,
} = await import("../../static/js/folderMoving.js");
const { serverProblem } = await import("../../static/js/lyricsUserText.js");

let pass = 0;
let fail = 0;
const check = (name, condition) => {
  if (condition) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
};
const MOVING = { detail: FOLDER_MOVING_DETAIL };
const SERVER_ERROR = 500;
const answer = (status, body) => new Response(JSON.stringify(body), { status });
const FALLBACK = { "pt-PT": "pt" };

check("the move's refusal is told apart", isFolderMoving(HTTP_CONFLICT, MOVING));
check("so is the split's", isFolderMoving(HTTP_CONFLICT, { detail: SPLIT_FOLDER_MOVING_DETAIL }));
check("and an edit's", isFolderMoving(HTTP_CONFLICT, { detail: EDIT_FOLDER_MOVING_DETAIL }));
check("another conflict is not it", !isFolderMoving(HTTP_CONFLICT, { detail: "already looking" }));
check("the sentence on another status is not it", !isFolderMoving(SERVER_ERROR, MOVING));
check("no body is not it", !isFolderMoving(HTTP_CONFLICT, null));

check("an answer that is the refusal", await refusedForFolderMove(answer(HTTP_CONFLICT, MOVING)));
check("an answer that is not", !(await refusedForFolderMove(answer(HTTP_CONFLICT, { detail: "x" }))));
check("no answer at all", !(await refusedForFolderMove(null)));
const read = answer(HTTP_CONFLICT, MOVING);
await refusedForFolderMove(read);
check("its body is left for the caller", (await read.json()).detail === FOLDER_MOVING_DETAIL);

const KEEP_FAILED = "lyrics.keepFailed";
check("a keep refused for the move says so", refusalKey({ status: HTTP_CONFLICT, data: MOVING }, KEEP_FAILED) === FOLDER_MOVING_KEY);
check("any other failure keeps its own notice", refusalKey({ status: SERVER_ERROR, data: null }, KEEP_FAILED) === KEEP_FAILED);
check("no answer keeps its own notice", refusalKey(null, KEEP_FAILED) === KEEP_FAILED);

const problem = serverProblem(HTTP_CONFLICT, MOVING);
check("the user's own words: said in their language", problem.key === FOLDER_MOVING_KEY && !problem.text);

const server = readFileSync(new URL("../../app/api/jobs.py", import.meta.url), "utf8");
check("the server's lyrics sentence", server.includes(`STEMS_FOLDER_MOVING = "${FOLDER_MOVING_DETAIL}"`));
check("the server's split sentence", server.includes(`"${SPLIT_FOLDER_MOVING_DETAIL}"`));
check("the server's edit sentence", server.includes(`STEMS_FOLDER_MOVING_EDIT = "${EDIT_FOLDER_MOVING_DETAIL}"`));

for (const { code } of LANGUAGES) {
  const table = { ...(TRANSLATIONS[FALLBACK[code]] ?? {}), ...TRANSLATIONS[code] };
  check(`${code} has ${FOLDER_MOVING_KEY}`, typeof table[FOLDER_MOVING_KEY] === "string" && table[FOLDER_MOVING_KEY] !== "");
}

console.log(fail ? `\n${fail} FAILED` : `\n${pass}/${pass} checks passed`);
process.exit(fail ? 1 : 0);
