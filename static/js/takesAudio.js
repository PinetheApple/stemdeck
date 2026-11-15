// Reads only the part of a take's audio.wav that holds sound.
//
// A take's file is as long as the song, mostly silence, so loading it whole would
// cost a stem's worth of memory per take. The server renders it as 16-bit stereo
// PCM and answers Range requests, so the header and then the clip's bytes are
// all that is fetched.

const HEADER_PROBE_BYTES = 64 * 1024;
const PCM16_BITS = 16;
const PCM16_SCALE = 32768;
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

function tag(view, off) {
  return String.fromCharCode(
    view.getUint8(off),
    view.getUint8(off + 1),
    view.getUint8(off + 2),
    view.getUint8(off + 3),
  );
}

/** The 16-bit PCM layout of a WAV prefix, or null when it is not one. */
export function parsePcm16Header(buf) {
  const view = new DataView(buf);
  if (buf.byteLength < RIFF_HEADER_BYTES || tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE") return null;
  let format = null;
  for (let off = RIFF_HEADER_BYTES; off + CHUNK_HEADER_BYTES <= buf.byteLength;) {
    const id = tag(view, off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      format = {
        channels: view.getUint16(off + 10, true),
        rate: view.getUint32(off + 12, true),
        bits: view.getUint16(off + 22, true),
      };
    } else if (id === "data") {
      if (!format || format.bits !== PCM16_BITS) return null;
      return { ...format, dataOffset: off + CHUNK_HEADER_BYTES, frameBytes: format.channels * 2 };
    }
    off += CHUNK_HEADER_BYTES + size + (size & 1);
  }
  return null;
}

/** The inclusive byte range of whole frames from `startSec` to `endSec`. */
export function regionBytes(header, startSec, endSec) {
  const first = Math.max(0, Math.floor(startSec * header.rate));
  const last = Math.max(first + 1, Math.ceil(endSec * header.rate));
  return {
    firstFrame: first,
    from: header.dataOffset + first * header.frameBytes,
    to: header.dataOffset + last * header.frameBytes - 1,
  };
}

/** Interleaved little-endian 16-bit samples, split into one float array per channel. */
export function pcm16ToChannels(bytes, channels) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames = Math.floor(bytes.byteLength / (channels * 2));
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      out[c][f] = view.getInt16((f * channels + c) * 2, true) / PCM16_SCALE;
    }
  }
  return out;
}

async function fetchRange(url, from, to) {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
  if (!res.ok) throw new Error(`take audio answered ${res.status}`);
  return res.arrayBuffer();
}

/**
 * The clip from `startSec` to `endSec` as an AudioBuffer, and the song time its
 * first sample belongs to.
 */
export async function loadTakeRegion(url, startSec, endSec) {
  const header = parsePcm16Header(await fetchRange(url, 0, HEADER_PROBE_BYTES - 1));
  if (!header) throw new Error("take audio is not 16-bit PCM");
  const range = regionBytes(header, startSec, endSec);
  const channels = pcm16ToChannels(new Uint8Array(await fetchRange(url, range.from, range.to)), header.channels);
  const buffer = new AudioBuffer({
    numberOfChannels: header.channels,
    length: channels[0].length || 1,
    sampleRate: header.rate,
  });
  channels.forEach((data, c) => buffer.copyToChannel(data, c));
  return { buffer, startSec: range.firstFrame / header.rate };
}
