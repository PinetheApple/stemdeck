// Play pressed while a song's stems still load, on both engines.
//
// The stem downloads and decodes are held behind gates, which keeps the
// loading window open long enough to press Play in it every time.
//
// Run:  node tests/js/play-before-ready.test.mjs

import { reachedEnd } from "../../static/js/playbackEnd.js";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ""}`);
  }
}

process.on("unhandledRejection", function failOnUnhandled(err) {
  console.error("UNHANDLED:", err);
  process.exitCode = 1;
});

check("end: position 0 of an unknown (0) duration is not an end", reachedEnd(0, 0) === false);
check("end: any position of a 0 duration is not an end", reachedEnd(5, 0) === false);
check("end: a negative duration has no end", reachedEnd(0, -1) === false);
check("end: a NaN duration has no end", reachedEnd(1, NaN) === false);
check("end: an infinite duration has no end", reachedEnd(1e9, Infinity) === false);
check("end: before a known duration is not an end", reachedEnd(5.99, 6) === false);
check("end: at a known duration is the end", reachedEnd(6, 6) === true);
check("end: past a known duration is the end", reachedEnd(6.2, 6) === true);
check("end: a NaN position is not an end", reachedEnd(NaN, 6) === false);

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const TRACK_SEC = 6;
const PCM_FORMAT = 1;
const FMT_CHUNK_BYTES = 16;
const SEEK_SEC = 3;
const PAST_END_SEC = 100;
const EPSILON = 1e-9;
// Without requestAnimationFrame the tick loop runs on a 100 ms timer, so this
// is three ticks: the bug ended the song on the first.
const THREE_TICKS_MS = 350;
const SETTLE_MS = 50;

function wav(seconds = TRACK_SEC) {
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  const audio = Buffer.alloc(Math.round(SAMPLE_RATE * seconds) * blockAlign);
  const fmt = Buffer.alloc(8 + FMT_CHUNK_BYTES);
  fmt.write("fmt ", 0, 4, "ascii");
  fmt.writeUInt32LE(FMT_CHUNK_BYTES, 4);
  fmt.writeUInt16LE(PCM_FORMAT, 8);
  fmt.writeUInt16LE(CHANNELS, 10);
  fmt.writeUInt32LE(SAMPLE_RATE, 12);
  fmt.writeUInt32LE(SAMPLE_RATE * blockAlign, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(BYTES_PER_SAMPLE * 8, 22);
  const data = Buffer.alloc(8);
  data.write("data", 0, 4, "ascii");
  data.writeUInt32LE(audio.length, 4);
  const body = Buffer.concat([Buffer.from("WAVE", "ascii"), fmt, data, audio]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, 4, "ascii");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

const FILES = new Map();
let fetchGate = Promise.resolve();
let releaseFetch = () => {};
function holdFetches() {
  fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
}

const missing = () => ({
  ok: false,
  status: 404,
  headers: { get: () => null },
  arrayBuffer: async () => new ArrayBuffer(0),
});

globalThis.fetch = async (url, opts = {}) => {
  await fetchGate;
  const file = FILES.get(url);
  if (!file) return missing();
  const range = /bytes=(\d+)-(\d+)/.exec(opts.headers?.Range || "");
  const start = range ? Number(range[1]) : 0;
  const end = range ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
  const slice = file.subarray(start, end + 1);
  return {
    ok: true,
    status: range ? 206 : 200,
    headers: { get: (h) => (h === "Content-Range" ? `bytes ${start}-${end}/${file.length}` : null) },
    arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
  };
};

let started = [];
const param = () => ({
  value: 1,
  setTargetAtTime() {},
  cancelScheduledValues() {},
  setValueAtTime() {},
  linearRampToValueAtTime() {},
});
const node = () => ({ gain: param(), connect() {}, disconnect() {} });
let decodeGate = Promise.resolve();
let decodes = 0;

class FakeCtx {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.state = "running";
    this.audioWorklet = null;
    this.sampleRate = SAMPLE_RATE;
  }

  addEventListener() {}
  removeEventListener() {}
  createGain() { return node(); }
  createAnalyser() { return { fftSize: 0, connect() {}, disconnect() {} }; }
  createBuffer(channels, length, rate) {
    return {
      numberOfChannels: channels,
      length,
      sampleRate: rate,
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    };
  }

  createBufferSource() {
    return {
      buffer: null,
      playbackRate: { value: 1 },
      connect() {},
      disconnect() {},
      stop() {},
      start(when, offset) { started.push({ when, offset }); },
    };
  }

  // The first stem decodes at once and the rest wait on decodeGate: the window
  // the full-decode engine used to start in with one stem.
  async decodeAudioData() {
    decodes++;
    if (decodes > 1) await decodeGate;
    return this.createBuffer(CHANNELS, SAMPLE_RATE * TRACK_SEC, SAMPLE_RATE);
  }

  async close() {}
}
globalThis.window = { AudioContext: FakeCtx };

const { createChunkedAudioEngine } = await import("../../static/js/chunkedAudioEngine.js");
const { createAudioEngine } = await import("../../static/js/audioEngine.js");

const ticks = () => new Promise((resolve) => { setTimeout(resolve, THREE_TICKS_MS); });
const settle = () => new Promise((resolve) => { setTimeout(resolve, SETTLE_MS); });
const STEMS = [{ name: "vocals", url: "/s/vocals.wav" }, { name: "bass", url: "/s/bass.wav" }];
const MISSING_STEMS = [{ name: "vocals", url: "/s/missing.wav" }];
FILES.set("/s/vocals.wav", wav());
FILES.set("/s/bass.wav", wav());

function chunked(stems = STEMS) {
  const ev = { ended: 0 };
  const eng = createChunkedAudioEngine(stems, { onEnded: () => { ev.ended++; } });
  started = [];
  return { eng, ev };
}

function fullDecode(stems = STEMS) {
  const ev = { ended: 0 };
  let releaseDecode = () => {};
  decodes = 0;
  decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
  const eng = createAudioEngine(stems, { onEnded: () => { ev.ended++; } });
  started = [];
  return { eng, ev, releaseDecode };
}

async function chunkedPlayWhileLoading() {
  holdFetches();
  const { eng, ev } = chunked();
  const play = eng.play();
  await ticks();
  check("chunked: Play while loading fires no onEnded", ev.ended === 0, `ended ${ev.ended}`);
  check("chunked: Play while loading reads as pressed", eng.isPlaying() === true);
  check("chunked: the clock is not ready while it waits", eng.isClockReady() === false);
  check("chunked: nothing started while it waits", started.length === 0, `${started.length} sources`);
  releaseFetch();
  const ok = await play;
  check("chunked: play() resolves true once loaded", ok === true, String(ok));
  check("chunked: starts once loaded, every stem", started.length === STEMS.length, `${started.length} sources`);
  check("chunked: the clock is ready after the start", eng.isClockReady() === true);
  await ticks();
  check("chunked: still no onEnded after the start", ev.ended === 0, `ended ${ev.ended}`);
  eng.destroy();
}

async function chunkedPauseDropsWait() {
  holdFetches();
  const { eng, ev } = chunked();
  const play = eng.play();
  eng.pause();
  check("chunked: Pause while waiting reads as paused", eng.isPlaying() === false);
  releaseFetch();
  check("chunked: a paused wait resolves false", (await play) === false);
  await ticks();
  check("chunked: a paused wait starts nothing", started.length === 0, `${started.length} sources`);
  check("chunked: a paused wait fires no onEnded", ev.ended === 0);
  eng.destroy();
}

async function chunkedStaleWaitStartsNothing() {
  holdFetches();
  const { eng } = chunked();
  const first = eng.play();
  eng.pause();
  const second = eng.play();
  releaseFetch();
  const [a, b] = await Promise.all([first, second]);
  check("chunked: Play, Pause, Play while loading: the stale wait resolves false", a === false);
  check("chunked: Play, Pause, Play while loading: the live one starts", b === true);
  check("chunked: Play, Pause, Play while loading: started once", started.length === STEMS.length, `${started.length} sources`);
  eng.destroy();
}

async function chunkedDestroyDropsWait() {
  holdFetches();
  const { eng, ev } = chunked();
  const play = eng.play();
  eng.destroy();
  releaseFetch();
  check("chunked: a wait on a destroyed engine resolves false", (await play) === false);
  await ticks();
  check("chunked: a destroyed engine's wait starts nothing", started.length === 0);
  check("chunked: a destroyed engine's wait fires no onEnded", ev.ended === 0);
}

async function chunkedSeekWhileLoading() {
  holdFetches();
  const { eng } = chunked();
  eng.seek(SEEK_SEC);
  const play = eng.play();
  releaseFetch();
  await play;
  check("chunked: a seek made while loading is where it starts",
    Math.abs(eng.getCurrentTime() - SEEK_SEC) < EPSILON, String(eng.getCurrentTime()));
  check("chunked: ...inside its chunk",
    started.every((s) => Math.abs(s.offset - SEEK_SEC) < EPSILON), JSON.stringify(started));
  eng.destroy();

  holdFetches();
  const late = chunked().eng;
  late.seek(PAST_END_SEC);
  releaseFetch();
  await late.ready;
  check("chunked: a seek past the end made while loading is clamped once known",
    late.getCurrentTime() === late.getDuration(), `${late.getCurrentTime()} of ${late.getDuration()}`);
  late.destroy();
}

async function chunkedFailedLoad() {
  holdFetches();
  const { eng, ev } = chunked(MISSING_STEMS);
  const play = eng.play();
  releaseFetch();
  check("chunked: failed load, ready() is false", (await eng.ready) === false);
  check("chunked: failed load, a waiting Play resolves false", (await play) === false);
  check("chunked: failed load, reads as not playing", eng.isPlaying() === false);
  await ticks();
  check("chunked: failed load, no onEnded", ev.ended === 0);
  check("chunked: failed load, nothing started", started.length === 0);
  eng.destroy();
}

async function chunkedReadyStartsAtOnce() {
  fetchGate = Promise.resolve();
  const { eng, ev } = chunked();
  await eng.ready;
  await settle();
  const play = eng.play();
  check("chunked: a ready track starts synchronously", started.length === STEMS.length, `${started.length} sources`);
  check("chunked: a ready track resolves true", (await play) === true);
  check("chunked: a ready track fires no onEnded on start", ev.ended === 0);
  eng.destroy();
}

async function fullDecodePlayWhileLoading() {
  const { eng, ev, releaseDecode } = fullDecode();
  await settle();
  const play = eng.play();
  check("fulldecode: Play while loading reads as pressed", eng.isPlaying() === true);
  check("fulldecode: nothing started while it waits", started.length === 0, `${started.length} sources`);
  releaseDecode();
  check("fulldecode: play() resolves true once loaded", (await play) === true);
  check("fulldecode: starts every stem, not just the first decoded",
    started.length === STEMS.length, `${started.length} sources`);
  await ticks();
  check("fulldecode: no onEnded", ev.ended === 0);
  eng.destroy();
}

async function fullDecodePauseAndDestroyDropWait() {
  const paused = fullDecode();
  const play = paused.eng.play();
  paused.eng.pause();
  check("fulldecode: Pause while waiting reads as paused", paused.eng.isPlaying() === false);
  paused.releaseDecode();
  check("fulldecode: a paused wait resolves false", (await play) === false);
  check("fulldecode: a paused wait starts nothing", started.length === 0);
  paused.eng.destroy();

  const gone = fullDecode();
  const waiting = gone.eng.play();
  gone.eng.destroy();
  gone.releaseDecode();
  check("fulldecode: a wait on a destroyed engine resolves false", (await waiting) === false);
  check("fulldecode: a destroyed engine's wait starts nothing", started.length === 0);
}

async function fullDecodeFailedLoad() {
  const { eng, ev, releaseDecode } = fullDecode(MISSING_STEMS);
  releaseDecode();
  const play = eng.play();
  check("fulldecode: failed load, a waiting Play resolves false", (await play) === false);
  check("fulldecode: failed load, reads as not playing", eng.isPlaying() === false);
  check("fulldecode: failed load, no onEnded", ev.ended === 0);
  eng.destroy();
}

await chunkedPlayWhileLoading();
await chunkedPauseDropsWait();
await chunkedStaleWaitStartsNothing();
await chunkedDestroyDropsWait();
await chunkedSeekWhileLoading();
await chunkedFailedLoad();
await chunkedReadyStartsAtOnce();
await fullDecodePlayWhileLoading();
await fullDecodePauseAndDestroyDropWait();
await fullDecodeFailedLoad();

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
