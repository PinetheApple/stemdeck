// A lyrics change refused while StemData moves (lyricsFolderMoving.js): told
// apart from other refusals, worded in every language, and the same sentence
// the server sends.
//
// Run:  node tests/js/lyrics-folder-moving.test.mjs

import { readFileSync } from "node:fs";

globalThis.window = {};
globalThis.document = { documentElement: { getAttribute: () => null }, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const { LANGUAGES, TRANSLATIONS } = await import("../../static/js/i18n.js");
const { FOLDER_MOVING_DETAIL, FOLDER_MOVING_KEY, isFolderMoving, refusedForFolderMove } = await import(
  "../../static/js/lyricsFolderMoving.js"
);
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
const HTTP_CONFLICT = 409;
const MOVING = { detail: FOLDER_MOVING_DETAIL };
const answer = (status, body) => new Response(JSON.stringify(body), { status });
const FALLBACK = { "pt-PT": "pt" };

check("the move's refusal is told apart", isFolderMoving(HTTP_CONFLICT, MOVING));
check("another conflict is not it", !isFolderMoving(HTTP_CONFLICT, { detail: "already looking" }));
check("the sentence on another status is not it", !isFolderMoving(500, MOVING));
check("no body is not it", !isFolderMoving(HTTP_CONFLICT, null));

check("an answer that is the refusal", await refusedForFolderMove(answer(HTTP_CONFLICT, MOVING)));
check("an answer that is not", !(await refusedForFolderMove(answer(HTTP_CONFLICT, { detail: "x" }))));
check("no answer at all", !(await refusedForFolderMove(null)));
const read = answer(HTTP_CONFLICT, MOVING);
await refusedForFolderMove(read);
check("its body is left for the caller", (await read.json()).detail === FOLDER_MOVING_DETAIL);

const problem = serverProblem(HTTP_CONFLICT, MOVING);
check("the user's own words: said in their language", problem.key === FOLDER_MOVING_KEY && !problem.text);

const server = readFileSync(new URL("../../app/api/jobs.py", import.meta.url), "utf8");
check("the server's own sentence", server.includes(`STEMS_FOLDER_MOVING = "${FOLDER_MOVING_DETAIL}"`));

for (const { code } of LANGUAGES) {
  const table = { ...(TRANSLATIONS[FALLBACK[code]] ?? {}), ...TRANSLATIONS[code] };
  check(`${code} has ${FOLDER_MOVING_KEY}`, typeof table[FOLDER_MOVING_KEY] === "string" && table[FOLDER_MOVING_KEY] !== "");
}

console.log(fail ? `\n${fail} FAILED` : `\n${pass}/${pass} checks passed`);
process.exit(fail ? 1 : 0);
