// The camera half of a filmed take: one MediaRecorder carrying the picture
// alone (sound has one clock, the recorder worklet), its chunks sent as camera
// parts, and when its first frame was taken. recorder.js drives it through
// start, createFields, upload, stop, finish(c0) and discard.

import { createPartUploader, TAKE_PART_SEC } from "./recorderParts.js";
import { cameraTiming } from "./filmTiming.js";
import { readCameraParts, sendCameraPart } from "./filmApi.js";

export const CAMERA_BITS_PER_SEC = 8_000_000;
const MS_PER_SEC = 1000;
// Byte parts skip the sample chunker: each chunk is already a whole part.
const WHOLE_PARTS = { partSamples: 1, channels: 1 };

function waitBeforeRetry(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} opts
 * @param {MediaStream} opts.stream  the open camera
 * @param {HTMLVideoElement} opts.preview  the playing preview, for frame capture times
 * @param {AudioContext} opts.ctx  the engine's context, the clock c0 is on
 * @param {string} opts.mime  from pickCameraMime ("" lets the recorder choose)
 * @param {{label:string, mirror:boolean, offsetMs:number}} opts.camera
 */
export function createCameraTake({ stream, preview, ctx, mime, camera }) {
  const track = stream.getVideoTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  const timing = { startMs: null, captureMs: null, stamp: null };
  const pending = [];
  let chain = Promise.resolve();
  let uploader = null;
  let recorder = null;
  let stopped = null;

  function onFirstFrame(nowMs, metadata) {
    const at = metadata?.captureTime;
    if (timing.startMs === null || (Number.isFinite(at) && at < timing.startMs)) {
      preview.requestVideoFrameCallback?.(onFirstFrame);
      return;
    }
    timing.captureMs = Number.isFinite(at) ? at : null;
    timing.stamp = ctx.getOutputTimestamp?.() ?? null;
  }

  function onRecorderStart(e) {
    timing.startMs = e.timeStamp;
    timing.stamp ??= ctx.getOutputTimestamp?.() ?? null;
  }

  function onChunk(e) {
    if (!e.data?.size) return;
    chain = chain.then(async function keepChunk() {
      const bytes = new Uint8Array(await e.data.arrayBuffer());
      if (uploader) uploader.pushPart(bytes);
      else pending.push(bytes);
    });
  }

  function start() {
    const options = { videoBitsPerSecond: CAMERA_BITS_PER_SEC, ...(mime ? { mimeType: mime } : {}) };
    recorder = new MediaRecorder(new MediaStream([track]), options);
    stopped = new Promise((resolve) => recorder.addEventListener("stop", resolve, { once: true }));
    recorder.addEventListener("start", onRecorderStart);
    recorder.addEventListener("dataavailable", onChunk);
    preview.requestVideoFrameCallback?.(onFirstFrame);
    recorder.start(TAKE_PART_SEC * MS_PER_SEC);
  }

  function createFields() {
    return {
      mime: recorder?.mimeType || mime,
      width: settings.width,
      height: settings.height,
      fps_nominal: settings.frameRate,
      device_label: camera.label || null,
      mirror: camera.mirror,
      offset_ms: camera.offsetMs,
    };
  }

  function upload(jobId, takeId) {
    uploader = createPartUploader(
      {
        send: function sendPart(seq, bytes, signal) {
          return sendCameraPart(jobId, takeId, seq, bytes, signal);
        },
        readState: function readPartState() {
          return readCameraParts(jobId, takeId);
        },
        wait: waitBeforeRetry,
      },
      WHOLE_PARTS,
    );
    for (const bytes of pending.splice(0)) uploader.pushPart(bytes);
  }

  function stop() {
    if (recorder?.state !== "inactive") recorder?.stop();
  }

  /** The finish body's camera block, or null when the picture can't be kept. */
  async function finish(c0) {
    stop();
    await stopped;
    await chain;
    const sent = await uploader?.finish();
    if (!sent?.ok) return null;
    const when = cameraTiming({ ...timing, c0 });
    return when && { ...when, parts: sent.sent };
  }

  function discard() {
    stop();
    pending.length = 0;
    uploader?.discard();
  }

  return { start, createFields, upload, stop, finish, discard };
}
