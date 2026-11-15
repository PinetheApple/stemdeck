// Uploads a take's audio in numbered parts. A resent last part is a no-op on the
// server, so retrying after a lost answer is safe; a 409 resumes from next_seq.

import { HTTP_CONFLICT } from "./lyricsTranscribe.js";
import { HTTP_NOT_FOUND } from "./libraryControls.js";

export const TAKE_PART_SEC = 2;
// The last delay repeats: a transient failure is retried until it clears or the take is discarded.
export const RETRY_DELAYS_MS = [250, 1000, 2000, 4000, 8000];

const HTTP_SUCCESS_END = 300;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

export const UPLOAD_ERROR = {
  finished: "finished",
  gap: "gap",
  refused: "refused",
  gone: "gone",
  discarded: "discarded",
};

// No status means the request never got an answer.
function isTransient(status) {
  if (status === null || status === undefined) return true;
  return status === HTTP_REQUEST_TIMEOUT || status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR;
}

function failureFor(status) {
  return status === HTTP_NOT_FOUND ? UPLOAD_ERROR.gone : UPLOAD_ERROR.refused;
}

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
 * @param {(seq:number, bytes:Uint8Array, signal:AbortSignal) => Promise<{status:number}>} io.send
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
  // Ending the upload aborts the request in flight and cuts any backoff short.
  const abort = new AbortController();
  const ended = new Promise(function whenEnded(resolve) {
    abort.signal.addEventListener("abort", resolve);
  });
  const pause = (ms) => Promise.race([wait(ms), ended]);

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

  function stop(reason) {
    if (error) return;
    error = reason;
    queue.length = 0;
    abort.abort();
  }

  async function sendHead() {
    const part = queue[0];
    for (let attempt = 0; !error; attempt++) {
      const status = await trySend(part, attempt);
      if (status !== null && status < HTTP_SUCCESS_END) {
        queue.shift();
        sent += 1;
        return;
      }
      if (status === HTTP_CONFLICT) return resync();
      if (!isTransient(status)) return stop(failureFor(status));
      await pause(delayFor(attempt));
    }
  }

  async function trySend(part, attempt) {
    try {
      const answer = await send(part.seq, part.bytes, abort.signal);
      return answer.status;
    } catch (err) {
      if (abort.signal.aborted) return null;
      if (attempt === 0) console.warn("[recorder] part upload failed, retrying:", err);
      return null;
    }
  }

  async function readServerState() {
    for (let attempt = 0; !error; attempt++) {
      try {
        return await Promise.race([readState(), ended.then(() => null)]);
      } catch (err) {
        if (!isTransient(err?.status)) return stop(failureFor(err.status));
        if (attempt === 0) console.warn("[recorder] could not read the take's upload state:", err);
        await pause(delayFor(attempt));
      }
    }
    return null;
  }

  async function resync() {
    const state = await readServerState();
    if (!state) return;
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
    /** A part that is already whole, such as a camera chunk. */
    pushPart(bytes) {
      enqueue([bytes]);
    },
    /** Send what is left and wait for the queue; resolves with the outcome. */
    async finish() {
      const rest = chunker.drain();
      if (rest) enqueue([rest]);
      while (pumping) await pumping;
      return { ok: !error && queue.length === 0, sent, error };
    },
    status: () => ({ queued: queue.length, sent, error }),
    /** Give up on what has not reached the server; the take stays there as unfinished. */
    discard() {
      stop(UPLOAD_ERROR.discarded);
    },
  };
}
