// The user's own lyrics helpers (lyricsUserText.js).
// Run:  node tests/js/lyrics-user-text.test.mjs

import {
  LYRICS_FILE_MAX_BYTES,
  LYRICS_MAX_CHARS,
  PROBLEM_EMPTY_FILE,
  PROBLEM_FILE_TYPE,
  PROBLEM_NOT_TEXT,
  PROBLEM_NETWORK,
  PROBLEM_REFUSED,
  PROBLEM_TOO_LONG,
  decodeLyricsBytes,
  decodedTextProblem,
  deleteUserText,
  editableRows,
  fileProblem,
  plainTexts,
  plainTimedLines,
  putUserText,
  serverProblem,
  splitLine,
  untimedRows,
} from "../../static/js/lyricsUserText.js";
import { fromServerLyrics, parseLrc } from "../../static/js/lyricsLookup.js";

let pass = 0;
let fail = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytes = (...values) => new Uint8Array(values);
const answering = (status, body) => async () => new Response(body, { status });


check("the file limit is what the server's character limit can take as UTF-8", LYRICS_FILE_MAX_BYTES === 4 * LYRICS_MAX_CHARS);
check("an .lrc of the largest size is read", fileProblem({ name: "a.LRC", size: LYRICS_FILE_MAX_BYTES }) === null);
check("a .txt is read", fileProblem({ name: "a.txt", size: 10 }) === null);
check("one byte over is refused before reading", fileProblem({ name: "a.lrc", size: LYRICS_FILE_MAX_BYTES + 1 })?.key === PROBLEM_TOO_LONG);
check("another file type is refused", fileProblem({ name: "a.png", size: 10 })?.key === PROBLEM_FILE_TYPE);
check("no name is refused", fileProblem({ name: "", size: 10 })?.key === PROBLEM_FILE_TYPE);

check("UTF-8 text is read", decodeLyricsBytes(new TextEncoder().encode("夜に駆ける")) === "夜に駆ける");
check("a byte order mark is not part of the text", decodeLyricsBytes(bytes(0xef, 0xbb, 0xbf, 0x41)) === "A");
check("an empty file is empty text for the server to refuse", decodeLyricsBytes(bytes()) === "");
check("binary is refused", decodeLyricsBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0xff, 0x00)) === null);
check("Latin-1 is refused, not garbled", decodeLyricsBytes(bytes(0x63, 0x61, 0x66, 0xe9)) === null);
check("UTF-16 is refused", decodeLyricsBytes(bytes(0xff, 0xfe, 0x41, 0x00)) === null);
check("valid UTF-8 holding control characters is refused", decodeLyricsBytes(bytes(0x41, 0x00, 0x42)) === null);
check("line breaks and tabs are text", decodeLyricsBytes(bytes(0x41, 0x0a, 0x09, 0x42, 0x0d, 0x0a)) === "A\n\tB\r\n");


check("a sentence from the server is shown", same(serverProblem(422, { detail: "There are no lyrics in this." }), { text: "There are no lyrics in this." }));
check("a 413 has its own message, whatever it says", same(serverProblem(413, { detail: "body too large" }), { key: PROBLEM_TOO_LONG }));
const listed = serverProblem(422, { detail: [{ loc: ["body", "text"], msg: "field required", type: "missing" }] });
check("list-shaped detail falls back to a message of ours", same(listed, { key: PROBLEM_REFUSED, status: 422 }), JSON.stringify(listed));
check("object detail too", same(serverProblem(422, { detail: { a: 1 } }), { key: PROBLEM_REFUSED, status: 422 }));
check("blank detail too", same(serverProblem(500, { detail: "  " }), { key: PROBLEM_REFUSED, status: 500 }));
check("no body at all too", same(serverProblem(502, null), { key: PROBLEM_REFUSED, status: 502 }));


const realFetch = globalThis.fetch;
const realWarn = console.warn;
console.warn = () => {};
{
  let asked = null;
  globalThis.fetch = async (url, init) => {
    asked = { url, init };
    return new Response('{"source":"user"}', { status: 200 });
  };
  const saved = await putUserText("abc", { text: "One", keep_timing: true });
  check("PUT goes to the track's user-text", asked.url === "/api/jobs/abc/lyrics/user-text" && asked.init.method === "PUT");
  check("PUT sends the body as given", same(JSON.parse(asked.init.body), { text: "One", keep_timing: true }));
  check("PUT answers the data", saved.ok && saved.data.source === "user");

  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const offline = await putUserText("abc", { text: "One" });
  check("a network failure is a problem, not a throw", !offline.ok && offline.problem.key === PROBLEM_NETWORK);
  const offlineBack = await deleteUserText("abc");
  check("a network failure going back too", !offlineBack.ok && offlineBack.problem.key === PROBLEM_NETWORK);

  globalThis.fetch = answering(502, "<html>Bad gateway</html>");
  const proxy = await putUserText("abc", { text: "One" });
  check("a body that is not JSON still gets a message", !proxy.ok && proxy.problem.key === PROBLEM_REFUSED && proxy.problem.status === 502);

  globalThis.fetch = answering(404, '{"detail":"no lyrics"}');
  const nothing = await deleteUserText("abc");
  check("DELETE's 404 is done, with nothing to offer", nothing.ok && nothing.nothingLeft === true);
  globalThis.fetch = answering(404, '{"others":[{"source":"lrclib","lrclib_id":7,"plain":"x"}]}');
  const offered = await deleteUserText("abc");
  check("DELETE's 404 is done, carrying versions", offered.ok && offered.data.others.length === 1);
  globalThis.fetch = answering(404, '{"detail":"no lyrics"}');
  check("PUT's 404 is a refusal", !(await putUserText("abc", { text: "One" })).ok);
  globalThis.fetch = answering(500, '{"detail":"could not restore lyrics"}');
  const stuck = await deleteUserText("abc");
  check("DELETE's 500 is a refusal in the server's words", !stuck.ok && stuck.problem.text === "could not restore lyrics");
}
check("undecodable text is refused as not text", decodedTextProblem(null)?.key === PROBLEM_NOT_TEXT);
check("an empty file is refused", decodedTextProblem("")?.key === PROBLEM_EMPTY_FILE);
check("a blank file is refused", decodedTextProblem(" \n\t\r\n")?.key === PROBLEM_EMPTY_FILE);
check("a file with words is accepted", decodedTextProblem("One") === null);
globalThis.fetch = realFetch;
console.warn = realWarn;


const TIMED = parseLrc("[00:00.00]\n[00:01.00] One\n[00:02.00]\n[00:03.00] Two\n[00:04.00] Three");
check("the editor leaves out an LRC's pauses", same(editableRows(TIMED, "ignored"), ["One", "Two", "Three"]));
check("plain text keeps its blank lines", same(editableRows([], "One\n\nTwo"), ["One", "", "Two"]));
check("no words, no rows", same(editableRows([], ""), []));
check("no entry, no rows", same(editableRows([], undefined), []));

check("a split loses the space at the cut", same(splitLine("Hello there world", 6), ["Hello", "there world"]));
check("a split at the end leaves an empty line after", same(splitLine("Hello", 5), ["Hello", ""]));
check("a split at the start leaves an empty line before", same(splitLine("Hello", 0), ["", "Hello"]));
check("a split works on Korean and Japanese", same(splitLine("夜に駆ける", 2), ["夜に", "駆ける"]));


check("untimed_lines count lines with words, not pauses", same([...untimedRows(TIMED, [0, 2])], [1, 4]));
check("no untimed lines, no flags", untimedRows(TIMED, undefined).size === 0);
check("an index past the end flags nothing", untimedRows(TIMED, [9]).size === 0);


check("plain text's lines are the server's: no blanks, spaces collapsed", same(plainTexts(" One  line \n\nTwo\r\n"), ["One line", "Two"]));
check("composed, as the server has them", same(plainTexts("café"), ["café"]));
check("nothing in nothing", same(plainTexts(undefined), []));
const shared = plainTimedLines("One\nTwo\n\nThree\nFour", 8);
check("lines are shared over the track", same(shared.map((l) => l.time), [0, 2, 4, 6]));
check("each with its text", same(shared.map((l) => l.text), ["One", "Two", "Three", "Four"]));
check("without a length they sit a few seconds apart", same(plainTimedLines("One\nTwo", 0).map((l) => l.time), [0, 3]));
check("too many to share are spaced out too", plainTimedLines("a\nb\nc", 0.1)[2].time === 6);


const USER = { v: 1, source: "user", track: "T", artist: "A", plain: "One\nTwo", synced: "[00:01.00] One\n[00:02.00] Two", instrumental: false, lrclib_id: null, others: [] };
const kept = fromServerLyrics({ ...USER, has_original: true, untimed_lines: [1] });
check("user lyrics are read, not dropped", kept?.entry?.source === "user");
check("has_original is mapped", kept.entry.hasOriginal === true);
check("untimed_lines is mapped", same(kept.entry.untimedLines, [1]));
const bare = fromServerLyrics({ ...USER, has_original: false }).entry;
check("no original, no field", !("hasOriginal" in bare));
check("no untimed lines, no field", !("untimedLines" in bare));
check("nonsense in untimed_lines is dropped", same(fromServerLyrics({ ...USER, untimed_lines: [0, "1", null, 2] }).entry.untimedLines, [0, 2]));
check("an answer of another shape is ignored", !("untimedLines" in fromServerLyrics({ ...USER, untimed_lines: "1" }).entry));
check("plain-only user lyrics are read", fromServerLyrics({ ...USER, synced: "" })?.entry?.plain === "One\nTwo");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
