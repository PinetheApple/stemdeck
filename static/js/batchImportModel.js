// batchImportModel.js — a batch import's items and their statuses, kept free of the
// DOM and the network so the rules can be tested on their own.

export const MAX_BATCH_LINKS = 100; // must match server MAX_BATCH_LINKS
export const MAX_BATCH_FILES = 500; // must match server MAX_BATCH_FILES
export const MAX_UPLOAD_BYTES = 400 * 1024 * 1024; // must match server _MAX_UPLOAD_BYTES
export const AUDIO_EXTS = [".mp3", ".wav", ".flac", ".mp4", ".m4a", ".ogg", ".opus"];

export const ITEM_KIND = Object.freeze({ LINK: "link", FILE: "file" });

export const ITEM_STATUS = Object.freeze({
  OK: "ok",
  IN_LIBRARY: "in_library",
  TOO_LONG: "too_long",
  NOT_A_LINK: "not_a_link",
  UNAVAILABLE: "unavailable",
  NOT_AUDIO: "not_audio",
  TOO_LARGE: "too_large",
  LOOKING_UP: "looking_up",
  UNCHECKED: "unchecked",
  NOT_QUEUED: "not_queued",
});

export const FLAG = Object.freeze({ DUP: "dup", BLOCK: "block" });

/** Per status: can it be ticked, is it ticked to start with, and its flag (kind, i18n key). */
const STATUS_RULES = {
  [ITEM_STATUS.OK]: { tickable: true, ticked: true, flag: null },
  [ITEM_STATUS.IN_LIBRARY]: { tickable: true, ticked: false, flag: { kind: FLAG.DUP, key: "batch.flag.inLibrary" } },
  [ITEM_STATUS.TOO_LONG]: { tickable: false, ticked: false, flag: { kind: FLAG.BLOCK, key: "batch.flag.tooLong" } },
  [ITEM_STATUS.NOT_A_LINK]: { tickable: false, ticked: false, flag: { kind: FLAG.BLOCK, key: "batch.flag.notALink" } },
  [ITEM_STATUS.UNAVAILABLE]: { tickable: false, ticked: false, flag: { kind: FLAG.BLOCK, key: "batch.flag.unavailable" } },
  [ITEM_STATUS.NOT_AUDIO]: { tickable: false, ticked: false, flag: { kind: FLAG.BLOCK, key: "batch.flag.notAudio" } },
  [ITEM_STATUS.TOO_LARGE]: { tickable: false, ticked: false, flag: { kind: FLAG.BLOCK, key: "batch.flag.tooLarge" } },
  [ITEM_STATUS.LOOKING_UP]: { tickable: false, ticked: true, flag: null },
  [ITEM_STATUS.UNCHECKED]: { tickable: false, ticked: false, flag: null },
  [ITEM_STATUS.NOT_QUEUED]: { tickable: true, ticked: true, flag: { kind: FLAG.BLOCK, key: "batch.flag.notQueued" } },
};

export const statusFlag = (status) => STATUS_RULES[status].flag;
export const isTickable = (item) => STATUS_RULES[item.status].tickable;
const tickedAtFirst = (status) => STATUS_RULES[status].ticked;

export const PATH_SEP = "/";
const HIDDEN_PREFIX = ".";
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB;

export function formatBytes(n) {
  return n < BYTES_PER_MB ? `${(n / BYTES_PER_KB).toFixed(0)} KB` : `${(n / BYTES_PER_MB).toFixed(1)} MB`;
}
export const isAudioName = (name) => AUDIO_EXTS.some((ext) => name.toLowerCase().endsWith(ext));
const isHiddenName = (name) => name.startsWith(HIDDEN_PREFIX);

/** A file the upload route would take: audio, and not over the size limit. */
export const isUploadable = (file) => isAudioName(file.name) && file.size <= MAX_UPLOAD_BYTES;

// ─── pasted links ───

/** Every pasted line, trimmed; blank ones stay so line numbers match the paste. */
export function pastedLines(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim());
}

const linkCount = (lines) => lines.filter(Boolean).length;
const LINK_LINE = /^https?:\/\//i;

/** Several lines, one of them at least a link; plain text stays a search. */
export function isPastedList(text) {
  const lines = pastedLines(text);
  return linkCount(lines) > 1 && lines.some((line) => LINK_LINE.test(line));
}

/** The lines up to the cap's last link, and how many links past it were refused. */
export function capLines(lines, max = MAX_BATCH_LINKS) {
  let seen = 0;
  const kept = [];
  for (const line of lines) {
    if (line && seen === max) break;
    if (line) seen += 1;
    kept.push(line);
  }
  return { lines: kept, refused: linkCount(lines) - seen };
}

/** One row per pasted link while the preview is out. */
export function lookingUpItems(lines) {
  return lines.flatMap((input, i) => (input ? [{
    key: `line-${i + 1}`,
    kind: ITEM_KIND.LINK,
    status: ITEM_STATUS.LOOKING_UP,
    ticked: true,
    input,
    line: i + 1,
    url: null,
    title: null,
    artist: null,
    durationSec: null,
    replaces: null,
    group: null,
  }] : []));
}

const groupKey = (line, url) => `playlist-${line}-${url}`;

function linkItem(raw, index) {
  return {
    key: `link-${index}`,
    kind: ITEM_KIND.LINK,
    status: raw.status,
    ticked: tickedAtFirst(raw.status),
    input: raw.input,
    line: raw.line,
    url: raw.url,
    title: raw.title,
    artist: raw.artist,
    durationSec: raw.duration_sec,
    replaces: raw.replaces,
    group: raw.playlist ? groupKey(raw.line, raw.playlist.url) : null,
  };
}

/** The preview's links as rows, and its playlists as the groups they fall under. */
export function linkItems(preview) {
  const items = (preview.items ?? []).map(linkItem);
  const groups = (preview.playlists ?? []).map((p) => ({
    key: groupKey(p.line, p.url),
    title: p.title,
    count: p.found,
    unavailable: p.unavailable,
    truncated: p.truncated,
    collapsed: false,
    showAll: false,
  }));
  return { items, groups };
}

// ─── folders and files ───

/** A folder picked with webkitdirectory: each file and the folder it sits in. */
export function folderFiles(list) {
  return [...(list ?? [])]
    .filter((file) => !isHiddenName(file.name))
    .map((file) => {
      const parts = (file.webkitRelativePath || file.name).split(PATH_SEP);
      return { file, dir: parts.slice(0, -1).join(PATH_SEP) };
    });
}

const readAll = (reader) => new Promise((ok, fail) => reader.readEntries(ok, fail));
const entryFile = (entry) => new Promise((ok, fail) => entry.file(ok, fail));
const joinPath = (dir, name) => (dir ? `${dir}${PATH_SEP}${name}` : name);

async function walkDirectory(entry, dir, out) {
  const reader = entry.createReader();
  // readEntries answers in pages; an empty page is the end.
  for (let page = await readAll(reader); page.length; page = await readAll(reader)) {
    for (const child of page) await walkEntry(child, dir, out);
  }
}

async function walkEntry(entry, dir, out) {
  if (isHiddenName(entry.name)) return;
  if (entry.isDirectory) await walkDirectory(entry, joinPath(dir, entry.name), out);
  else if (entry.isFile) out.push({ file: await entryFile(entry), dir });
}

/** Every file under dropped entries (webkitGetAsEntry), subfolders included. */
export async function walkEntries(entries) {
  const out = [];
  for (const entry of entries) await walkEntry(entry, "", out);
  return out;
}

const byFolderThenName = (a, b) => NAME_ORDER.compare(a.dir, b.dir) || NAME_ORDER.compare(a.file.name, b.file.name);

function fileStatus(file, answer, durationSec, maxDurationSec) {
  if (!isAudioName(file.name)) return ITEM_STATUS.NOT_AUDIO;
  if (file.size > MAX_UPLOAD_BYTES) return ITEM_STATUS.TOO_LARGE;
  if (maxDurationSec && durationSec > maxDurationSec) return ITEM_STATUS.TOO_LONG;
  return answer ? answer.status : ITEM_STATUS.LOOKING_UP;
}

/** Names the preview checks: the uploadable files, in review order. */
export const previewNames = (entries) => [...entries].sort(byFolderThenName)
  .filter((e) => isUploadable(e.file))
  .map((e) => e.file.name);

/** The files in review order up to the cap's last uploadable one, and how many were left out. */
export function capEntries(entries, max = MAX_BATCH_FILES) {
  const sorted = [...entries].sort(byFolderThenName);
  let seen = 0;
  const kept = sorted.filter((entry) => {
    if (!isUploadable(entry.file)) return true;
    seen += 1;
    return seen <= max;
  });
  return { entries: kept, refused: sorted.length - kept.length };
}

/** Rows still waiting on a preview that failed: nobody could check them. */
export const markUnchecked = (items) => items.map((item) => (
  item.status === ITEM_STATUS.LOOKING_UP ? { ...item, status: ITEM_STATUS.UNCHECKED, ticked: false } : item
));

/** A folder's (or a set of files') rows, in folder then name order. `preview`
 *  is the server's answer for `previewNames`, or null while it is out. */
export function fileItems(entries, preview, durations) {
  const answers = [...(preview?.files ?? [])];
  return [...entries].sort(byFolderThenName).map(({ file, dir }, i) => {
    const durationSec = durations.get(file) ?? null;
    const answer = isUploadable(file) && preview ? answers.shift() : null;
    const status = fileStatus(file, answer, durationSec, preview?.max_duration_sec);
    return {
      key: `file-${i}`,
      kind: ITEM_KIND.FILE,
      status,
      ticked: tickedAtFirst(status),
      file,
      name: file.name,
      dir,
      durationSec,
      replaces: answer?.replaces ?? null,
      group: null,
    };
  });
}

// ─── queuing ───

const capacityKey = (kind) => `${kind}s`;

/** The ticked items to send, in order, each kind cut to the room left for it. */
export function queuePlan(items, capacity) {
  const wanted = items.filter((item) => item.ticked && isTickable(item));
  if (!capacity) return { send: wanted, clamped: false };
  const room = { ...capacity };
  const send = wanted.filter((item) => {
    const key = capacityKey(item.kind);
    if (!(room[key] > 0)) return false;
    room[key] -= 1;
    return true;
  });
  return { send, clamped: send.length < wanted.length };
}

/** Send each item in turn. A refusal leaves that item out; a full queue leaves
 *  out the rest of its kind too, all with `queueFullReason`. */
export async function queueItems(items, { postLink, postFile, isQueueFull, reasonOf, queueFullReason }) {
  const queued = [];
  const notQueued = [];
  const fullReason = new Map();
  for (const item of items) {
    if (fullReason.has(item.kind)) {
      notQueued.push({ item, reason: fullReason.get(item.kind) });
      continue;
    }
    try {
      const post = item.kind === ITEM_KIND.FILE ? postFile : postLink;
      queued.push({ item, jobId: await post(item) });
    } catch (err) {
      const reason = isQueueFull(err) ? queueFullReason : reasonOf(err);
      if (isQueueFull(err)) fullReason.set(item.kind, reason);
      notQueued.push({ item, reason });
    }
  }
  return { queued, notQueued: notQueued.sort((a, b) => items.indexOf(a.item) - items.indexOf(b.item)) };
}
