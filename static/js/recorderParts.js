// Uploads a take's audio in numbered parts. A resent last part is a no-op on the
// server, so retrying after a lost answer is safe; a 409 resumes from next_seq.

import { HTTP_CONFLICT } from "./lyricsTranscribe.js";
import { HTTP_NOT_FOUND } from "./libraryControls.js";

export const TAKE_PART_SEC = 2;
// The last delay repeats: a part is retried for as long as the take lives.
export const RETRY_DELAYS_MS = [250, 1000, 2000, 4000, 8000];

const HTTP_SUCCESS_END = 300;
const HTTP_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE = 422;
const FATAL_STATUSES = new Set([HTTP_NOT_FOUND, HTTP_TOO_LARGE, HTTP_UNPROCESSABLE]);

export const UPLOAD_ERROR = {
  finished: "finished",
  gap: "gap",
  refused: "refused",
};

/**
 * Collects interleaved float32 samples and hands back whole parts of
 * `partSamples` each; `drain` returns what is left, cut to whole frames.
 */
export function createPartChunker(partSamples, channels) {
  let pending = new Float32Array(partSamples);
  let filled = 0;

  function push(samples) {
    const parts = [];
    let from = 0;
    while (from < samples.length) {
      const take = Math.min(partSamples - filled, samples.length - from);
      pending.set(samples.subarray(from, from + take), filled);
      filled += take;
      from += take;
      if (filled === partSamples) {
        parts.push(pending);
        pending = new Float32Array(partSamples);
        filled = 0;
      }
    }
    return parts;
  }

  function drain() {
    const whole = filled - (filled % channels);
    const rest = whole > 0 ? pending.slice(0, whole) : null;
    filled = 0;
    return rest;
  }

  return { push, drain, pendingSamples: () => filled };
}

function asBytes(samples) {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * @param {object} io
 * @param {(seq:number, bytes:Uint8Array) => Promise<{status:number}>} io.send
 * @param {() => Promise<{next_seq:number, finished:boolean}>} io.readState
 * @param {(ms:number) => Promise<void>} io.wait
 */
export function createPartUploader(
  { send, readState, wait },
  { partSamples, channels, retryDelaysMs = RETRY_DELAYS_MS },
) {
  const chunker = createPartChunker(partSamples, channels);
  const queue = [];
  let nextSeq = 0;
  let sent = 0;
  let error = null;
  let pumping = null;

  function enqueue(parts) {
    for (const samples of parts) queue.push({ seq: nextSeq++, bytes: asBytes(samples) });
    if (parts.length) kick();
  }

  function kick() {
    if (!pumping && !error) pumping = pump().finally(() => { pumping = null; });
    return pumping;
  }

  async function pump() {
    while (queue.length && !error) await sendHead();
  }

  const delayFor = (attempt) => retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)];

  async function sendHead() {
    const part = queue[0];
    for (let attempt = 0; ; attempt++) {
      const status = await trySend(part, attempt);
      if (status !== null && status < HTTP_SUCCESS_END) {
        queue.shift();
        sent += 1;
        return;
      }
      if (status === HTTP_CONFLICT) return resync();
      if (FATAL_STATUSES.has(status)) {
        error = UPLOAD_ERROR.refused;
        return;
      }
      await wait(delayFor(attempt));
    }
  }

  async function trySend(part, attempt) {
    try {
      const answer = await send(part.seq, part.bytes);
      return answer.status;
    } catch (err) {
      if (attempt === 0) console.warn("[recorder] part upload failed, retrying:", err);
      return null;
    }
  }

  async function readServerState() {
    for (let attempt = 0; ; attempt++) {
      try {
        return await readState();
      } catch (err) {
        if (attempt === 0) console.warn("[recorder] could not read the take's upload state:", err);
        await wait(delayFor(attempt));
      }
    }
  }

  async function resync() {
    const state = await readServerState();
    if (state.finished) {
      error = UPLOAD_ERROR.finished;
      return;
    }
    while (queue.length && queue[0].seq < state.next_seq) {
      queue.shift();
      sent += 1;
    }
    if (queue.length && queue[0].seq > state.next_seq) error = UPLOAD_ERROR.gap;
  }

  return {
    push(samples) {
      enqueue(chunker.push(samples));
    },
    /** Send what is left and wait for the queue; resolves with the outcome. */
    async finish() {
      const rest = chunker.drain();
      if (rest) enqueue([rest]);
      while (pumping) await pumping;
      return { ok: !error && queue.length === 0, sent, error };
    },
    status: () => ({ queued: queue.length, sent, error }),
  };
}
