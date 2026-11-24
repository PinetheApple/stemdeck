import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MY_ORDER_URL,
  applyMyOrder,
  loadMyOrder,
  moveBefore,
  myOrderAfterMove,
  saveMyOrder,
} from "../../static/js/myOrder.js";
import { DEFAULT_FILTERS, FAST_MIN_BPM, SLOW_MAX_BPM, TEMPO_BANDS, filterSongs } from "../../static/js/libraryFilter.js";

const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const FAST_BPM = FAST_MIN_BPM + 1;
const SLOW_BPM = SLOW_MAX_BPM - 1;
const requests = [];

function answer(status, body) {
  return { ok: status === HTTP_OK, status, json: async () => body };
}

function stubFetch(respond) {
  requests.length = 0;
  globalThis.fetch = (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method: init.method, body });
    return respond(body);
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

const echo = (body) => Promise.resolve(answer(HTTP_OK, body));
const tick = () => new Promise((done) => setTimeout(done));

test("loading reads the saved ids", async () => {
  stubFetch(() => Promise.resolve(answer(HTTP_OK, { song_ids: ["x", "y"] })));
  assert.deepEqual(await loadMyOrder(), ["x", "y"]);
  assert.equal(requests[0].url, MY_ORDER_URL);
  assert.equal(requests[0].method, "GET");
});

test("saving puts the whole order", async () => {
  stubFetch(echo);
  assert.deepEqual(await saveMyOrder(["b", "a"]), ["b", "a"]);
  assert.deepEqual(requests, [{ url: MY_ORDER_URL, method: "PUT", body: { song_ids: ["b", "a"] } }]);
});

test("a save waits for the one before it, so the last one wins", async () => {
  const first = deferred();
  stubFetch((body) => (requests.length === 1 ? first.promise : echo(body)));
  const firstSave = saveMyOrder(["1"]);
  const secondSave = saveMyOrder(["2"]);
  await tick();
  assert.equal(requests.length, 1);
  first.resolve(answer(HTTP_OK, { song_ids: ["1"] }));
  await Promise.all([firstSave, secondSave]);
  assert.deepEqual(requests.map((request) => request.body.song_ids), [["1"], ["2"]]);
});

test("a failed save rejects, and the next save still goes", async () => {
  stubFetch((body) => Promise.resolve(body.song_ids[0] === "bad" ? answer(HTTP_CONFLICT, {}) : answer(HTTP_OK, body)));
  await assert.rejects(saveMyOrder(["bad"]), (err) => err.status === HTTP_CONFLICT);
  assert.deepEqual(await saveMyOrder(["good"]), ["good"]);
});

test("songs not in the order come first, newest first, then the order", () => {
  const songs = [
    { id: "old", createdAt: 1 },
    { id: "listed1", createdAt: 2 },
    { id: "new", createdAt: 3 },
    { id: "listed2", createdAt: 4 },
  ];
  const placed = applyMyOrder(songs, ["listed2", "gone", "listed1"]);
  assert.deepEqual(placed.map((song) => song.id), ["new", "old", "listed2", "listed1"]);
});

test("one song moves before another", () => {
  const order = ["a", "b", "c", "d"];
  assert.deepEqual(moveBefore(order, ["d"], "b"), ["a", "d", "b", "c"]);
  assert.deepEqual(moveBefore(order, ["a"], "d"), ["b", "c", "a", "d"]);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("several songs move together, keeping their order", () => {
  assert.deepEqual(moveBefore(["a", "b", "c", "d", "e"], ["d", "b"], "a"), ["b", "d", "a", "c", "e"]);
});

test("no target moves to the end; a target among the moved changes nothing", () => {
  assert.deepEqual(moveBefore(["a", "b", "c"], ["a"], null), ["b", "c", "a"]);
  assert.deepEqual(moveBefore(["a", "b", "c"], ["a"], undefined), ["b", "c", "a"]);
  assert.deepEqual(moveBefore(["a", "b", "c"], ["a", "b"], "b"), ["a", "b", "c"]);
});

test("a target the order does not have changes nothing", () => {
  assert.deepEqual(moveBefore(["a", "b", "c"], ["a"], "gone"), ["a", "b", "c"]);
});

test("a move with filters on keeps the hidden songs in their places", () => {
  const library = [
    { id: "a", bpm: FAST_BPM, createdAt: 1 },
    { id: "hidden1", bpm: SLOW_BPM, createdAt: 2 },
    { id: "b", bpm: FAST_BPM, createdAt: 3 },
    { id: "hidden2", bpm: SLOW_BPM, createdAt: 4 },
    { id: "c", bpm: FAST_BPM, createdAt: 5 },
  ];
  const saved = library.map((song) => song.id);
  const shown = filterSongs(library, { ...DEFAULT_FILTERS, tempo: TEMPO_BANDS.FAST }).map((song) => song.id);
  assert.deepEqual(shown, ["a", "b", "c"]);
  assert.deepEqual(myOrderAfterMove(library, saved, ["c"], "a"), ["c", "a", "hidden1", "b", "hidden2"]);
});

test("a move places songs never ordered before, newest first, ahead of the saved order", () => {
  const library = [{ id: "a", createdAt: 1 }, { id: "b", createdAt: 2 }, { id: "new", createdAt: 3 }];
  assert.deepEqual(myOrderAfterMove(library, ["b", "a"], ["a"], "b"), ["new", "a", "b"]);
});
