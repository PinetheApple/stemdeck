// Lyrics a browser kept, carried over to the server once (lyricsCarryOver.js).
// Run:  node tests/js/lyrics-carry-over.test.mjs

import { carryOverLyrics, carryOverRequest, lyricsStoreKey, retryLater } from "../../static/js/lyricsCarryOver.js";

let pass = 0;
let fail = 0;
const check = (name, condition, detail = "") => {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${name}`, detail);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const SYNCED = "[00:00.50] One\n[00:02.00] Two";
const ENTRY = {
  v: 1,
  source: "lrclib",
  id: 77,
  track: "Fixture Song",
  artist: "Fixture Band",
  album: "Chosen",
  duration: 6,
  instrumental: false,
  synced: SYNCED,
  plain: "",
  savedAt: 1,
  offsetSec: 0.5,
  userSynced: "[00:00.40] One\n[00:02.10] Two",
  aligned: { synced: SYNCED, method: "dtw", matched: 0.9, linesMatched: 2, lines: 2, at: 12 },
};
const STATE = { job_id: "a", title: "Fixture Song", audio_tags: { artist: "Fixture Band", title: "Fixture Song" } };

check("the store key is the one the tab used", lyricsStoreKey("a") === "stemdeck.lyrics.a");

const put = carryOverRequest({ entry: ENTRY, others: [] }, STATE);
check("a kept entry goes up as a PUT", put?.method === "PUT");
check("as the user's pick", put?.picked === true);
check(
  "in the server's shape, its timing included",
  same(put?.body, {
    source: "lrclib",
    track: "Fixture Song",
    artist: "Fixture Band",
    album: "Chosen",
    duration: 6,
    instrumental: false,
    synced: SYNCED,
    plain: "",
    lrclib_id: 77,
    offset_sec: 0.5,
    user_synced: ENTRY.userSynced,
    aligned: { synced: SYNCED, method: "dtw", matched: 0.9, lines_matched: 2, lines: 2, at: 12 },
  }),
  put?.body,
);
const fromFile = carryOverRequest({ entry: { ...ENTRY, source: "file", id: 0, offsetSec: 0, userSynced: "", aligned: null } }, STATE);
check("a file's lyrics have no LRCLIB id, and no timing of their own", same(
  [fromFile.body.lrclib_id, "offset_sec" in fromFile.body, "user_synced" in fromFile.body, "aligned" in fromFile.body],
  [null, false, false, false],
), fromFile.body);
check("a file's lyrics were kept without a pick, and go up as none", fromFile.picked === false);
check("a removal goes up as a DELETE", same(carryOverRequest({ dismissed: true }, STATE), { method: "DELETE" }));
check("nothing usable carries nothing", carryOverRequest({ others: [] }, STATE) === null);

const another = { entry: { ...ENTRY, track: "Joao de Barro" } };
check("another song's lyrics are not carried", carryOverRequest(another, STATE) === null);
check(
  "an alias of the song is the song",
  carryOverRequest(another, { ...STATE, identity: { title: "Barro", title_aliases: ["Joao de Barro"] } })?.method === "PUT",
);
check("with no song known, the entry is carried", carryOverRequest(another, { job_id: "a", title: "x" })?.method === "PUT");

for (const status of [null, 500, 503]) check(`${status} is tried again later`, retryLater(status, "done"));
for (const status of [200, 404, 413, 422]) check(`${status} is final`, !retryLater(status, "done"));
for (const jobStatus of ["queued", "separating", "stopped"]) {
  check(`409 on a ${jobStatus} job is tried again later`, retryLater(409, jobStatus));
}
for (const jobStatus of ["error", "cancelled"]) check(`409 on a ${jobStatus} job is final`, !retryLater(409, jobStatus));

/** A store of browser entries and a server answering `statuses` per track. */
function fakeDeps(entries, statuses) {
  const store = new Map(Object.entries(entries));
  const sent = [];
  const carried = [];
  return {
    store,
    sent,
    carried,
    deps: {
      read: async (id) => store.get(id) ?? null,
      drop: async (id) => store.delete(id),
      send: async (id, request) => {
        sent.push({ id, ...request });
        return statuses[id];
      },
      carried: (id) => carried.push(id),
    },
  };
}

const job = (id, status = "done") => ({ ...STATE, job_id: id, status });
const kept = { entry: ENTRY, others: [] };
{
  const ids = ["ok", "removed", "gone", "refused", "busy", "failing", "offline", "none"];
  const { store, sent, carried, deps } = fakeDeps(
    {
      ok: kept,
      removed: { dismissed: true },
      gone: kept,
      refused: kept,
      busy: kept,
      failing: kept,
      offline: kept,
      broken: kept,
      cancelled: kept,
    },
    { ok: 200, removed: 404, gone: 404, refused: 422, busy: 409, failing: 500, offline: null, broken: 409, cancelled: 409 },
  );
  const jobs = [...ids.map((id) => job(id, id === "busy" ? "queued" : "done")), job("broken", "error"), job("cancelled", "cancelled")];
  const finished = await carryOverLyrics(jobs, deps);
  check("an entry left for later means not finished", finished === false);
  check("each entry is sent once, none for a track without one", sent.length === 9, sent);
  check("a removal is sent as one", sent.find((s) => s.id === "removed")?.method === "DELETE");
  check("2xx, any 404 and 422 drop the entry", ["ok", "removed", "gone", "refused"].every((id) => !store.has(id)));
  check("409 on a job that ended without its stems drops it", ["broken", "cancelled"].every((id) => !store.has(id)));
  check("409, 5xx and no answer keep it", ["busy", "failing", "offline"].every((id) => store.has(id)));
  check("only a request the server took is followed up", same(carried, ["ok"]), carried);
}
{
  const { store, sent, deps } = fakeDeps({ a: another, b: kept }, { b: 200 });
  const finished = await carryOverLyrics([job("a"), job("b")], deps);
  check("another song's entry is dropped unsent", !store.has("a") && sent.every((s) => s.id !== "a"), sent);
  check("every entry settled is finished", finished === true);
}
{
  const { sent, deps } = fakeDeps({}, {});
  check("nothing kept is finished at once", (await carryOverLyrics([job("a")], deps)) === true && sent.length === 0);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
