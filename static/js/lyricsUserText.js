// The user's own lyrics: server calls, refusal reasons, text and timing helpers.
// A problem is { text } when the server worded it, else { key, status? } for i18n.js.

import { HTTP_NOT_FOUND } from "./libraryControls.js";

// _TEXT_MAX_CHARS in app/pipeline/lyrics_lookup.py.
export const LYRICS_MAX_CHARS = 100_000;
const UTF8_MAX_BYTES_PER_CHAR = 4;
export const LYRICS_FILE_MAX_BYTES = UTF8_MAX_BYTES_PER_CHAR * LYRICS_MAX_CHARS;

export const ACCEPTED_FILE_TYPES = ".lrc,.txt";
const ACCEPTED_FILE_NAME = /\.(lrc|txt)$/i;
// _NOT_TEXT in app/pipeline/lyrics_lookup.py, less the surrogates a decode cannot give.
const NOT_TEXT = /[\x00-\x08\x0e-\x1f\x7f�]/;

const FALLBACK_LINE_GAP_SEC = 3;
const MIN_LINE_GAP_SEC = 0.1;
const STAMP_RESOLUTION = 100;

const STATUS_TOO_LONG = 413;

export const PROBLEM_TOO_LONG = "lyrics.supply.tooLong";
export const PROBLEM_FILE_TYPE = "lyrics.supply.fileType";
export const PROBLEM_NOT_TEXT = "lyrics.supply.notText";
export const PROBLEM_READ_FAILED = "lyrics.supply.readFailed";
export const PROBLEM_EMPTY_FILE = "lyrics.supply.emptyFile";
export const PROBLEM_NETWORK = "lyrics.supply.network";
export const PROBLEM_REFUSED = "lyrics.supply.refused";

/** Why a chosen file cannot be read as lyrics, from its name and size alone,
 * so a huge one is never read into memory; null when it may be. */
export function fileProblem({ name, size }) {
  if (!ACCEPTED_FILE_NAME.test(String(name || ""))) return { key: PROBLEM_FILE_TYPE };
  if (size > LYRICS_FILE_MAX_BYTES) return { key: PROBLEM_TOO_LONG };
  return null;
}

/** A file's bytes as text, or null when they are not UTF-8 text. Strict: a
 * lenient decode would turn a Latin-1 file's accents into replacement marks. */
export function decodeLyricsBytes(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return NOT_TEXT.test(text) ? null : text;
}

/** Why a file's decoded text (decodeLyricsBytes) cannot be lyrics, or null when it can. */
export function decodedTextProblem(text) {
  if (text == null) return { key: PROBLEM_NOT_TEXT };
  return text.trim() ? null : { key: PROBLEM_EMPTY_FILE };
}

/** What to tell the user about a refusal: the server's own sentence when
 * `detail` is one. FastAPI's validation errors make `detail` a list. */
export function serverProblem(status, data) {
  if (status === STATUS_TOO_LONG) return { key: PROBLEM_TOO_LONG };
  const detail = data?.detail;
  if (typeof detail === "string" && detail.trim()) return { text: detail };
  return { key: PROBLEM_REFUSED, status };
}

async function sendUserText(trackId, init) {
  let res;
  try {
    res = await fetch(`/api/jobs/${encodeURIComponent(trackId)}/lyrics/user-text`, init);
  } catch (err) {
    console.warn("lyrics user text request failed", err);
    return { ok: false, problem: { key: PROBLEM_NETWORK } };
  }
  const data = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data };
  return { ok: false, status: res.status, data, problem: serverProblem(res.status, data) };
}

/** Keep `body`, { text, keep_timing? }, as the track's lyrics. */
export function putUserText(trackId, body) {
  return sendUserText(trackId, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Go back to what the user's lyrics replaced. A 404 is that being done too:
 * they were all the track had, and it may carry versions to offer. */
export async function deleteUserText(trackId) {
  const answer = await sendUserText(trackId, { method: "DELETE" });
  return answer.status === HTTP_NOT_FOUND ? { ...answer, ok: true, nothingLeft: true } : answer;
}

/** The lines the editor starts from: the words of what is timed, pauses left
 * out, or plain text with its blank lines. */
export function editableRows(timedLines, plain) {
  if (timedLines.length) return timedLines.map((line) => line.text).filter(Boolean);
  return plain ? plain.split(/\r?\n/) : [];
}

/** A line cut in two at `caret`, without the space at the cut. */
export function splitLine(text, caret) {
  return [text.slice(0, caret).trimEnd(), text.slice(caret).trimStart()];
}

/** Plain text's lines as the server counts them: plain_lines() and line_text()
 * in app/pipeline/lyrics_retime.py. */
export function plainTexts(plain) {
  return String(plain || "")
    .normalize("NFC")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Lines of plain text with starting times to adjust by hand, shared over
 * `length` seconds when that leaves them room. */
export function plainTimedLines(plain, length) {
  const texts = plainTexts(plain);
  const shared = length > 0 ? length / texts.length : 0;
  const gap = shared >= MIN_LINE_GAP_SEC ? shared : FALLBACK_LINE_GAP_SEC;
  return texts.map((text, i) => ({ time: Math.round(i * gap * STAMP_RESOLUTION) / STAMP_RESOLUTION, text }));
}

/** Which rows of `lines` are named by the server's `untimed_lines`. It counts
 * lines with words only, and an LRC's empty stamps are rows here. */
export function untimedRows(lines, untimed) {
  const rows = new Set();
  const wanted = new Set(untimed);
  if (!wanted.size) return rows;
  let sung = 0;
  lines.forEach((line, row) => {
    if (!line.text) return;
    if (wanted.has(sung)) rows.add(row);
    sung += 1;
  });
  return rows;
}
