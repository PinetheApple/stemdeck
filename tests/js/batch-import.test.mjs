// A batch import's review list: what a paste or a folder holds, what can be
// ticked, how much of it fits in the queue, and how the queuing goes on past
// a refusal.
//
// Run:  node tests/js/batch-import.test.mjs

globalThis.window = {};
globalThis.document = {
  documentElement: { getAttribute: () => null },
  getElementById: () => null,
  querySelectorAll: () => [],
};
globalThis.localStorage = { getItem: () => null, setItem: () => {} };

const {
  ITEM_STATUS, MAX_BATCH_LINKS, capLines, fileItems, folderFiles, isPastedList, isTickable,
  linkItems, lookingUpItems, pastedLines, previewNames, queuePlan, queueItems, walkEntries,
} = await import("../../static/js/batchImportModel.js");
const { batchProgress } = await import("../../static/js/queue.js");

let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ─── pasted lines ───
const pasted = "https://youtu.be/a\r\n\n  https://youtu.be/b  \nsetlist for sunday\n";
check("lines keep blanks so line numbers match the paste", eq(pastedLines(pasted), ["https://youtu.be/a", "", "https://youtu.be/b", "setlist for sunday", ""]));
check("two lines are a list", isPastedList("a\nb"));
check("one line with blank lines around it is not a list", !isPastedList("\n https://youtu.be/a \n\n"));

const many = Array.from({ length: MAX_BATCH_LINKS + 3 }, (_, i) => `https://youtu.be/${i}`);
const capped = capLines(["", ...many]);
check("lines past the cap are refused", capped.refused === 3, String(capped.refused));
check("the cap counts links, not blank lines", capped.lines.length === MAX_BATCH_LINKS + 1);
check("under the cap nothing is refused", capLines(["a", "", "b"]).refused === 0);

const waiting = lookingUpItems(["https://youtu.be/a", "", "x"]);
check("each non-blank line waits as its own row", waiting.length === 2 && waiting.every((i) => i.status === ITEM_STATUS.LOOKING_UP));
check("a waiting row keeps its line number", waiting[1].line === 3);

// ─── a resolved paste ───
const PREVIEW = {
  items: [
    { input: "l1", line: 1, url: "u1", title: "Goodness", artist: "Bethel", duration_sec: 357, status: "in_library", existing_job_id: "j1", replaces: null, playlist: null },
    { input: "l2", line: 2, url: "u2", title: "Build", artist: null, duration_sec: 372, status: "ok", existing_job_id: null, replaces: "gone2", playlist: null },
    { input: "p", line: 3, url: "u3", title: "Holy", artist: null, duration_sec: 300, status: "ok", existing_job_id: null, replaces: null, playlist: { url: "pl", title: "Worship", index: 1 } },
    { input: "p", line: 3, url: "u4", title: "Same", artist: null, duration_sec: 300, status: "too_long", existing_job_id: null, replaces: null, playlist: { url: "pl", title: "Worship", index: 2 } },
    { input: "setlist", line: 7, url: null, title: null, artist: null, duration_sec: null, status: "not_a_link", existing_job_id: null, replaces: null, playlist: null },
  ],
  playlists: [{ input: "p", line: 3, url: "pl", title: "Worship", found: 2, unavailable: 0, truncated: false }],
  files: [],
  max_duration_sec: 1200,
  capacity_left: { links: 10, files: 5 },
};
const { items, groups } = linkItems(PREVIEW);
const byUrl = (u) => items.find((i) => i.url === u);
check("in library is unticked by default", byUrl("u1").ticked === false && isTickable(byUrl("u1")));
check("ok is ticked by default", byUrl("u2").ticked === true);
check("a gone copy is carried as replaces", byUrl("u2").replaces === "gone2");
check("too long cannot be ticked", !isTickable(byUrl("u4")) && byUrl("u4").ticked === false);
const notLink = items.find((i) => i.status === ITEM_STATUS.NOT_A_LINK);
check("not a link cannot be ticked and keeps its line", !isTickable(notLink) && notLink.line === 7);
check("a playlist becomes one group", groups.length === 1 && groups[0].title === "Worship");
check("a playlist's tracks belong to its group", byUrl("u3").group === groups[0].key && byUrl("u4").group === groups[0].key);
check("a track pasted alone belongs to no group", byUrl("u2").group === null);

// ─── folder files ───
const file = (name, size = 1000) => ({ name, size });
const picked = [
  Object.assign(file("b.mp3"), { webkitRelativePath: "Sunday set/Acoustic/b.mp3" }),
  Object.assign(file("a.flac"), { webkitRelativePath: "Sunday set/a.flac" }),
  Object.assign(file(".DS_Store"), { webkitRelativePath: "Sunday set/.DS_Store" }),
];
const fromPicker = folderFiles(picked);
check("a picked folder keeps each file's folder", eq(fromPicker.map((e) => e.dir), ["Sunday set/Acoustic", "Sunday set"]));
check("hidden files are left out of a folder", fromPicker.every((e) => e.file.name !== ".DS_Store"));

const entries = [
  { dir: "Sunday set", file: file("setlist.pdf") },
  { dir: "Sunday set/Acoustic", file: file("02 b.mp3") },
  { dir: "Sunday set", file: file("10 c.wav") },
  { dir: "Sunday set", file: file("2 a.wav", 900 * 1024 * 1024) },
  { dir: "Sunday set", file: file("long.wav") },
  { dir: "Sunday set", file: file("dup.m4a") },
];
const asked = previewNames(entries);
check("the preview is asked about audio it could upload, in review order", eq(asked, ["10 c.wav", "dup.m4a", "long.wav", "02 b.mp3"]), JSON.stringify(asked));
const answer = (name, status = "ok", replaces = null) => ({ name, status, existing_job_id: null, replaces });
const filePreview = {
  files: [answer("10 c.wav"), answer("dup.m4a", "in_library", "g9"), answer("long.wav"), answer("02 b.mp3")],
  max_duration_sec: 1200,
};
const durations = new Map([[entries[4].file, 3600], [entries[2].file, 200]]);
const filed = fileItems(entries, filePreview, durations);
const named = (n) => filed.find((i) => i.name === n);
check("a folder lists its own files before a subfolder's", eq(filed.map((i) => i.dir), ["Sunday set", "Sunday set", "Sunday set", "Sunday set", "Sunday set", "Sunday set/Acoustic"]));
check("names sort as numbers read", filed.findIndex((i) => i.name === "2 a.wav") < filed.findIndex((i) => i.name === "10 c.wav"));
check("not audio cannot be ticked", named("setlist.pdf").status === ITEM_STATUS.NOT_AUDIO && !isTickable(named("setlist.pdf")));
check("a file over the size limit cannot be ticked", named("2 a.wav").status === ITEM_STATUS.TOO_LARGE && !isTickable(named("2 a.wav")));
check("a file over the length limit cannot be ticked", named("long.wav").status === ITEM_STATUS.TOO_LONG);
check("a file already imported is unticked, with its gone copy", named("dup.m4a").status === ITEM_STATUS.IN_LIBRARY && !named("dup.m4a").ticked && named("dup.m4a").replaces === "g9");
check("a file's duration is shown when known", named("10 c.wav").durationSec === 200);

const names = ["01.wav", "02.wav"];
check("files the preview has not answered yet are looking up", fileItems(names.map((n) => ({ dir: "", file: file(n) })), null, new Map()).every((i) => i.status === ITEM_STATUS.LOOKING_UP));

// ─── walking a dropped folder ───
const fileEntry = (name) => ({ isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) });
function dirEntry(name, children, pageSize = 2) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      let at = 0;
      return {
        readEntries(ok) {
          const page = children.slice(at, at + pageSize);
          at += pageSize;
          setTimeout(() => ok(page), 0);
        },
      };
    },
  };
}
const tree = dirEntry("Sunday set", [
  fileEntry("a.wav"),
  fileEntry(".hidden"),
  dirEntry("Acoustic", [fileEntry("b.wav"), dirEntry("Deeper", [fileEntry("c.wav")])]),
  fileEntry("d.wav"),
]);
const walked = await walkEntries([tree, fileEntry("loose.wav")]);
check("a dropped folder is walked into its subfolders", eq(walked.map((e) => `${e.dir}|${e.file.name}`).sort(), [
  "|loose.wav", "Sunday set/Acoustic/Deeper|c.wav", "Sunday set/Acoustic|b.wav", "Sunday set|a.wav", "Sunday set|d.wav",
].sort()), JSON.stringify(walked.map((e) => `${e.dir}|${e.file.name}`)));

// ─── capacity ───
const link = (n, extra = {}) => ({ key: `l${n}`, kind: "link", status: ITEM_STATUS.OK, ticked: true, ...extra });
const fileItem = (n) => ({ key: `f${n}`, kind: "file", status: ITEM_STATUS.OK, ticked: true });
const queueable = [link(1), link(2), link(3, { ticked: false }), fileItem(1), link(4), link(5, { status: ITEM_STATUS.TOO_LONG })];
const plan = queuePlan(queueable, { links: 2, files: 5 });
check("Queue N is clamped to the room left for each kind", eq(plan.send.map((i) => i.key), ["l1", "l2", "f1"]));
check("a clamped plan says so", plan.clamped === true);
check("an unclamped plan does not", queuePlan(queueable, { links: 10, files: 10 }).clamped === false);
check("with no capacity known nothing is clamped", queuePlan(queueable, null).send.length === 4);

// ─── queuing past refusals ───
class Full extends Error {}
const isQueueFull = (err) => err instanceof Full;
const sent = [];
const outcome = await queueItems(
  [link(1), fileItem(1), link(2), link(3), fileItem(2)],
  {
    postLink: async (item) => {
      sent.push(item.key);
      if (item.key === "l2") throw new Full("the queue is full");
      return `job-${item.key}`;
    },
    postFile: async (item) => {
      sent.push(item.key);
      if (item.key === "f1") throw new Error("refused");
      return `job-${item.key}`;
    },
    isQueueFull,
    reasonOf: (err) => err.message,
  },
);
check("a refused item does not stop the rest", sent.includes("f2"), JSON.stringify(sent));
check("a full queue stops sending that kind only", !sent.includes("l3"), JSON.stringify(sent));
check("what was queued keeps its job id", eq(outcome.queued.map((q) => q.jobId), ["job-l1", "job-f2"]));
check("everything left out says why", eq(outcome.notQueued.map((n) => [n.item.key, n.reason]), [
  ["f1", "refused"], ["l2", "the queue is full"], ["l3", "the queue is full"],
]), JSON.stringify(outcome.notQueued.map((n) => [n.item.key, n.reason])));

// ─── the queue view's batch header ───
const snap = { running: { job_id: "a" }, queued: [{ job_id: "b" }] };
const statuses = { c: "done", d: "error", e: "cancelled" };
const progress = batchProgress(["a", "b", "c", "d", "e", "gone"], snap, (id) => statuses[id]);
check("a batch counts done, failed and waiting", eq([progress.total, progress.done, progress.failed, progress.waiting], [4, 1, 1, 2]), JSON.stringify(progress));
check("a batch names its failed items", eq(progress.failedIds, ["d"]));

console.log(fail ? `\n${fail} FAILED` : `\n${pass}/${pass} checks passed`);
process.exit(fail ? 1 : 0);
