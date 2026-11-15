// Reading a take's clip out of its song-length audio.wav (#98).
//
// Run:  node tests/js/takes-audio.test.mjs

import { parsePcm16Header, pcm16ToChannels, regionBytes } from "../../static/js/takesAudio.js";

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

const RATE = 44100;
const CHANNELS = 2;

function chunk(id, body) {
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  view.setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function fmt(bits) {
  const body = new Uint8Array(16);
  const view = new DataView(body.buffer);
  view.setUint16(0, 1, true);
  view.setUint16(2, CHANNELS, true);
  view.setUint32(4, RATE, true);
  view.setUint32(8, RATE * CHANNELS * (bits / 8), true);
  view.setUint16(12, CHANNELS * (bits / 8), true);
  view.setUint16(14, bits, true);
  return body;
}

function wav(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 4);
  const out = new Uint8Array(8 + total);
  const view = new DataView(out.buffer);
  out.set([82, 73, 70, 70], 0);
  view.setUint32(4, total, true);
  out.set([87, 65, 86, 69], 8);
  let off = 12;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}

{
  const list = chunk("LIST", new Uint8Array(26));
  const buf = wav([list, chunk("fmt ", fmt(16)), chunk("data", new Uint8Array(16))]);
  const header = parsePcm16Header(buf);
  check("finds data behind a LIST chunk", header?.dataOffset === 12 + list.length + 24 + 8, JSON.stringify(header));
  check("reads the format", header.rate === RATE && header.channels === CHANNELS && header.frameBytes === 4);
}

{
  check("refuses float audio", parsePcm16Header(wav([chunk("fmt ", fmt(32)), chunk("data", new Uint8Array(8))])) === null);
  check("refuses a non-WAV", parsePcm16Header(new ArrayBuffer(64)) === null);
}

{
  const header = { rate: RATE, channels: CHANNELS, dataOffset: 44, frameBytes: 4 };
  const range = regionBytes(header, 1, 2);
  check("a region starts on its first frame", range.from === 44 + RATE * 4 && range.firstFrame === RATE);
  check("a region ends on a frame boundary", (range.to + 1 - range.from) === RATE * 4);
}

{
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setInt16(0, 16384, true);
  view.setInt16(2, -32768, true);
  view.setInt16(4, 0, true);
  view.setInt16(6, 32767, true);
  const [left, right] = pcm16ToChannels(bytes, CHANNELS);
  check("deinterleaves left", left[0] === 0.5 && left[1] === 0);
  check("deinterleaves right", right[0] === -1 && Math.abs(right[1] - 1) < 1e-4);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
