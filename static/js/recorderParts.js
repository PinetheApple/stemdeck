// Cuts captured audio into numbered parts and uploads them in order.
//
// The server takes part `seq` only when it is exactly the next one, and treats a
// resent last part as a no-op, so a retry after a lost answer is always safe. A
// 409 means the two sides disagree on where the take is: the uploader reads the
// server's next_seq and carries on from there. No DOM and no fetch here; the
// caller injects how a part is sent and how the server state is read.

export const TAKE_PART_SEC = 2;
export const RETRY_DELAYS_MS = [250, 1000, 2000, 4000, 8000];

const HTTP_CONFLICT = 409;
const FATAL_STATUSES = new Set([404, 413, 422]);

export const UPLOAD_ERROR = {
  finished: "finished",
  gap: "gap",
  refused: "refused",
  stalled: "stalled",
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

  async function sendHead() {
    const part = queue[0];
    for (let attempt = 0; ; attempt++) {
      const status = await trySend(part);
      if (status !== null && status < 300) {
        queue.shift();
        sent += 1;
        return;
      }
      if (status === HTTP_CONFLICT) return resync();
      if (FATAL_STATUSES.has(status)) {
        error = UPLOAD_ERROR.refused;
        return;
      }
      if (attempt >= retryDelaysMs.length) {
        error = UPLOAD_ERROR.stalled;
        return;
      }
      await wait(retryDelaysMs[attempt]);
    }
  }

  async function trySend(part) {
    try {
      const answer = await send(part.seq, part.bytes);
      return answer.status;
    } catch (err) {
      console.warn("[recorder] part upload failed, retrying:", err);
      return null;
    }
  }

  async function resync() {
    let state;
    try {
      state = await readState();
    } catch (err) {
      console.warn("[recorder] could not read the take's upload state:", err);
      error = UPLOAD_ERROR.stalled;
      return;
    }
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
    /** Try a stalled queue again, e.g. once the connection is back. */
    retry() {
      if (error !== UPLOAD_ERROR.stalled) return pumping;
      error = null;
      return kick();
    },
    status: () => ({ queued: queue.length, sent, error }),
  };
}
