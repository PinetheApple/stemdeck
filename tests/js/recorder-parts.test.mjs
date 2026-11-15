// Part chunking, numbering and retry for take uploads.
//
// Run:  node tests/js/recorder-parts.test.mjs

import {
  createPartChunker,
  createPartUploader,
  UPLOAD_ERROR,
} from "../../static/js/recorderParts.js";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
}

const STEREO = 2;
const PART_SAMPLES = 8;
const noWait = () => Promise.resolve();
const ramp = (from, n) => Float32Array.from({ length: n }, (_, i) => from + i);
const floats = (bytes) => new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

/** A server that keeps parts like the real one: exact next seq, a resent last part is a no-op. */
function fakeServer({ failFirst = 0, answers = [] } = {}) {
  const parts = [];
  let failures = failFirst;
  const scripted = [...answers];
  return {
    parts,
    async send(seq, bytes) {
      if (scripted.length) return { status: scripted.shift() };
      if (failures > 0) {
        failures -= 1;
        throw new Error("network down");
      }
      if (seq === parts.length - 1) return { status: 200 };
      if (seq !== parts.length) return { status: 409 };
      parts.push(Array.from(floats(bytes)));
      return { status: 200 };
    },
    async readState() {
      return { next_seq: parts.length, finished: false };
    },
  };
}

{
  const chunker = createPartChunker(PART_SAMPLES, STEREO);
  const first = chunker.push(ramp(0, 5));
  const second = chunker.push(ramp(5, 14));
  check("chunker holds a short push", first.length === 0);
  check("chunker cuts whole parts across pushes", second.length === 2);
  check(
    "parts keep the sample order",
    Array.from(second[0]).join() === "0,1,2,3,4,5,6,7" && second[1][0] === 8,
  );
  check("chunker keeps the remainder", chunker.pendingSamples() === 3);
  const rest = chunker.drain();
  check("drain cuts the remainder to whole frames", rest.length === 2 && rest[0] === 16, String(rest?.length));
  check("drain empties the chunker", chunker.pendingSamples() === 0 && chunker.drain() === null);
}

{
  const server = fakeServer();
  const up = createPartUploader({ ...server, wait: noWait }, { partSamples: PART_SAMPLES, channels: STEREO });
  up.push(ramp(0, 20));
  const result = await up.finish();
  check("uploads every part in order", server.parts.length === 3, JSON.stringify(server.parts));
  check("the last part is the whole-frame remainder", server.parts[2].join() === "16,17,18,19");
  check("finish reports success", result.ok && result.sent === 3 && result.error === null);
}

{
  const server = fakeServer({ failFirst: 2 });
  const waits = [];
  const up = createPartUploader(
    { ...server, wait: (ms) => { waits.push(ms); return Promise.resolve(); } },
    { partSamples: PART_SAMPLES, channels: STEREO, retryDelaysMs: [5, 10, 20] },
  );
  up.push(ramp(0, 8));
  const result = await up.finish();
  check("a network failure is retried with backoff", waits.join() === "5,10", waits.join());
  check("the retried part lands once", result.ok && server.parts.length === 1);
}

{
  const server = fakeServer();
  server.parts.push([0, 1, 2, 3, 4, 5, 6, 7]);
  const up = createPartUploader({ ...server, wait: noWait }, { partSamples: PART_SAMPLES, channels: STEREO });
  up.push(ramp(0, 16));
  await up.finish();
  check(
    "a part the server already has is not appended twice",
    server.parts.length === 2 && server.parts[1][0] === 8,
    JSON.stringify(server.parts),
  );
}

{
  const server = fakeServer();
  server.parts.push([0], [1]);
  const up = createPartUploader({ ...server, wait: noWait }, { partSamples: PART_SAMPLES, channels: STEREO });
  up.push(ramp(0, 24));
  const result = await up.finish();
  check(
    "a 409 resumes from the server's next_seq",
    result.ok && server.parts.length === 3 && server.parts[2][0] === 16,
    JSON.stringify(server.parts),
  );
}

{
  const server = fakeServer({ answers: [413] });
  const up = createPartUploader({ ...server, wait: noWait }, { partSamples: PART_SAMPLES, channels: STEREO });
  up.push(ramp(0, 16));
  const result = await up.finish();
  check("a refused part stops the upload", result.error === UPLOAD_ERROR.refused && server.parts.length === 0);
}

const OUTAGE_MS = 60_000;

/** A server that is down until the virtual clock passes `downUntilMs`, and a wait that moves that clock. */
function outage(downUntilMs) {
  const clock = { now: 0, waits: [] };
  const server = fakeServer();
  const healthy = server.send;
  server.send = function sendUnlessDown(seq, bytes) {
    if (clock.now < downUntilMs) return Promise.reject(new Error("server down"));
    return healthy(seq, bytes);
  };
  const wait = function advanceClock(ms) {
    clock.waits.push(ms);
    clock.now += ms;
    return Promise.resolve();
  };
  return { server, clock, wait };
}

{
  const { server, clock, wait } = outage(OUTAGE_MS);
  const up = createPartUploader(
    { send: server.send, readState: server.readState, wait },
    { partSamples: PART_SAMPLES, channels: STEREO, retryDelaysMs: [250, 1000, 4000] },
  );
  up.push(ramp(0, 24));
  const result = await up.finish();
  check("a minute-long outage loses no part", result.ok && server.parts.length === 3, JSON.stringify(result));
  check("parts keep their order after the outage", server.parts.map((p) => p[0]).join() === "0,8,16");
  check("the backoff is capped", Math.max(...clock.waits) === 4000, String(Math.max(...clock.waits)));
}

/** Raises like fetchJson does for a failed answer. */
function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

const NOT_FOUND = 404;
const UNPROCESSABLE = 422;
const UNAVAILABLE = 503;
const GIVE_UP_AFTER_WAITS = 50;

/** A wait that counts its calls and gives up on a loop that would never end. */
function countingWait() {
  const waits = { count: 0 };
  waits.wait = function countWait() {
    waits.count += 1;
    if (waits.count > GIVE_UP_AFTER_WAITS) throw new Error("still retrying");
    return Promise.resolve();
  };
  return waits;
}

{
  const server = fakeServer({ answers: [409] });
  server.readState = () => Promise.reject(httpError(NOT_FOUND));
  const waits = countingWait();
  const up = createPartUploader({ ...server, wait: waits.wait }, { partSamples: PART_SAMPLES, channels: STEREO });
  up.push(ramp(0, 24));
  const result = await up.finish().catch((err) => ({ thrown: String(err) }));
  check("a take deleted during a resync ends the upload", Boolean(result.error) && result.error === UPLOAD_ERROR.gone, JSON.stringify(result));
  check("a deleted take is not retried", waits.count === 0, String(waits.count));
  check("a deleted take drops what was queued", up.status().queued === 0, JSON.stringify(up.status()));
}

{
  const server = fakeServer({ answers: [UNPROCESSABLE] });
  const waits = countingWait();
  const up = createPartUploader({ ...server, wait: waits.wait }, { partSamples: PART_SAMPLES, channels: STEREO });
  up.push(ramp(0, 24));
  const result = await up.finish().catch((err) => ({ thrown: String(err) }));
  check("a refusal ends the upload", result.error === UPLOAD_ERROR.refused && waits.count === 0, JSON.stringify(result));
  check("a refusal drops what was queued", up.status().queued === 0, JSON.stringify(up.status()));
}

{
  const server = fakeServer({ answers: [UNAVAILABLE, UNAVAILABLE] });
  const waits = countingWait();
  const up = createPartUploader({ ...server, wait: waits.wait }, { partSamples: PART_SAMPLES, channels: STEREO });
  up.push(ramp(0, 16));
  const result = await up.finish();
  check("a server error is retried", result.ok && waits.count === 2, JSON.stringify(result));
}

{
  const { server, wait } = outage(Number.POSITIVE_INFINITY);
  let up = null;
  let waited = 0;
  const discardOnThirdWait = function waitThenDiscard(ms) {
    waited += 1;
    if (waited === 3) up.discard();
    return wait(ms);
  };
  up = createPartUploader(
    { send: server.send, readState: server.readState, wait: discardOnThirdWait },
    { partSamples: PART_SAMPLES, channels: STEREO },
  );
  up.push(ramp(0, 16));
  const result = await up.finish();
  check("discarding ends an upload stuck in an outage", Boolean(result.error) && result.error === UPLOAD_ERROR.discarded && waited === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
