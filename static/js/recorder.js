// One take, from Record to finish.
//
// Capture starts on the press, before any count-in, so a pickup note is kept.
// Once the song's clock is running the first captured frame is placed on it:
// frame0 is the song position leaving the graph when that frame was captured,
// with no device latency folded in; the server subtracts the round trip. The
// take is created then, its parts upload as they fill, and anything that takes
// the song away (a seek, a loop wrap, pause, another song, an engine swap) stops
// it and finishes it on the song it was recorded on.

import { audioEngine, currentJobId, playbackSpeed } from "./state.js";
import { createTickLoop } from "./tickLoop.js";
import { startCapture } from "./recorderCapture.js";
import { createPartUploader, TAKE_PART_SEC } from "./recorderParts.js";
import { armedTrack } from "./recorderArm.js";
import { savedRoundTrip, takeLatency } from "./latencyStore.js";
import { createTake, finishTake, readParts, sendPart } from "./takesApi.js";

export const REC_PHASE = { counting: "counting", recording: "recording", finishing: "finishing" };
export const RECORD_BLOCK = { speed: "speed", noTrack: "noTrack", noInput: "noInput", noEngine: "noEngine" };
export const STOP_REASON = { user: "user", transport: "transport", switched: "switched" };

const NORMAL_SPEED = 1;
const SPEED_TOLERANCE = 1e-6;
// The clock is read for placement only once the song has visibly moved past
// the start, so getCurrentTime is no longer held at the start position.
const CLOCK_SETTLE_SEC = 0.05;

let take = null;
const listeners = new Set();
const loop = createTickLoop(tick);

/** `fn(event)`: {type:"change"} or {type:"finished"|"failed", jobId, takeId, reason}. */
export function onRecorderEvent(fn) {
  listeners.add(fn);
}

function emit(event) {
  for (const fn of listeners) fn(event);
}

/** The take in progress, for drawing it: where it starts on the song and its peaks so far. */
export function recordingTake() {
  if (!take) return null;
  const { jobId, trackId, takeId, phase, startPos, frame0, peaks } = take;
  return { jobId, trackId, takeId, phase, startSec: frame0 ?? startPos, peaks };
}

export function takeElapsedSec() {
  if (!take?.rate) return 0;
  return take.frames / take.rate;
}

export function recordBlock() {
  if (Math.abs(playbackSpeed - NORMAL_SPEED) > SPEED_TOLERANCE) return RECORD_BLOCK.speed;
  const arm = armedTrack();
  if (!arm || arm.jobId !== currentJobId) return RECORD_BLOCK.noTrack;
  if (!arm.input || arm.problem) return RECORD_BLOCK.noInput;
  if (!audioEngine?.ctxTimeToSourceTime) return RECORD_BLOCK.noEngine;
  return null;
}

/** Start a take on the armed track, or stop the one running. */
export async function toggleRecording({ label, countIn }) {
  if (take) return stopTake(STOP_REASON.user);
  if (recordBlock()) return null;
  const eng = audioEngine;
  const arm = armedTrack();
  take = newTake(eng, arm, label);
  const playing = eng.isPlaying();
  if (!playing) countIn();
  emit({ type: "change" });
  try {
    take.capture = await startCapture(arm.input, arm.channels, {
      onStart: (sec, rate) => onCaptureStart(sec, rate),
      onAudio: (samples, peak) => onCaptureAudio(samples, peak),
    });
  } catch (err) {
    console.warn("[recorder] capture could not start:", err);
    take = null;
    emit({ type: "change" });
    return null;
  }
  loop.schedule();
  return take;
}

function newTake(eng, arm, label) {
  return {
    jobId: arm.jobId,
    trackId: arm.trackId,
    label,
    engine: eng,
    info: arm.info,
    requestedInput: arm.requestedInput,
    channels: arm.channels,
    startPos: eng.getCurrentTime(),
    phase: REC_PHASE.counting,
    pending: [],
    peaks: [],
    frame0: null,
    frames: 0,
    rate: 0,
    c0: null,
    takeId: null,
    created: null,
    uploader: null,
    epoch: null,
  };
}

function onCaptureStart(sec, rate) {
  if (!take) return;
  take.c0 = sec;
  take.rate = rate;
}

function onCaptureAudio(samples, peak) {
  if (!take) return;
  take.frames += samples.length / take.channels.length;
  take.peaks.push(peak);
  if (take.uploader) take.uploader.push(samples);
  else take.pending.push(samples);
}

function songChanged(t) {
  return audioEngine !== t.engine || t.engine.audioContext.state === "closed" || currentJobId !== t.jobId;
}

function tick() {
  if (!take || take.phase === REC_PHASE.finishing) return;
  loop.schedule();
  if (songChanged(take)) {
    stopTake(STOP_REASON.switched);
    return;
  }
  const eng = take.engine;
  if (take.phase === REC_PHASE.counting) {
    if (!eng.isPlaying()) stopTake(STOP_REASON.transport);
    else if (clockRunning(eng) && take.c0 !== null) beginTake(eng);
    return;
  }
  if (!eng.isPlaying() || eng.getScheduleEpoch() !== take.epoch) stopTake(STOP_REASON.transport);
}

function clockRunning(eng) {
  return eng.isClockReady() && eng.getCurrentTime() > take.startPos + CLOCK_SETTLE_SEC;
}

/** The song position leaving the graph at context time `sec`. */
function songTimeAt(eng, sec) {
  const outputOffset = eng.ctxTimeToSourceTime(eng.audioContext.currentTime) - eng.getCurrentTime();
  return eng.ctxTimeToSourceTime(sec) - outputOffset;
}

function beginTake(eng) {
  const frame0 = songTimeAt(eng, take.c0);
  take.frame0 = frame0;
  take.phase = REC_PHASE.recording;
  take.epoch = eng.getScheduleEpoch();
  take.created = createOnServer(take, frame0);
  emit({ type: "change" });
}

async function createOnServer(t, frame0) {
  const saved = (await savedRoundTrip(t.info.deviceId)) ?? (await savedRoundTrip(t.requestedInput));
  const answer = await createTake(t.jobId, {
    track_id: t.trackId,
    label: t.label,
    timeline: { frame0_song_sec: frame0, tempo: NORMAL_SPEED, count_in_sec: Math.max(0, t.startPos - frame0) },
    latency: takeLatency(t.engine.audioContext, t.info.latencySec, saved),
    capture: { rate: t.rate, channels: t.channels.length, device_label: t.info.label || null },
  });
  t.takeId = answer.take_id;
  t.uploader = createUploader(t);
  for (const samples of t.pending.splice(0)) t.uploader.push(samples);
  return t.takeId;
}

function createUploader(t) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return createPartUploader(
    {
      send: (seq, bytes) => sendPart(t.jobId, t.takeId, seq, bytes),
      readState: () => readParts(t.jobId, t.takeId),
      wait,
    },
    { partSamples: Math.round(t.rate * TAKE_PART_SEC) * t.channels.length, channels: t.channels.length },
  );
}

function endSongSec(t) {
  if (songChanged(t)) return null;
  return t.engine.getCurrentTime();
}

/** Stop capture, send what is left and finish the take on its own song. */
export async function stopTake(reason) {
  const t = take;
  if (!t || t.phase === REC_PHASE.finishing) return null;
  const wasRecording = t.phase === REC_PHASE.recording;
  t.phase = REC_PHASE.finishing;
  const endSec = endSongSec(t);
  emit({ type: "change" });
  const dropped = await t.capture?.stop();
  const outcome = wasRecording ? await finishOnServer(t, endSec, dropped ?? 0) : null;
  take = null;
  emit({ type: "change" });
  if (outcome) emit({ ...outcome, jobId: t.jobId, trackId: t.trackId, reason });
  return outcome;
}

async function finishOnServer(t, endSec, dropped) {
  try {
    await t.created;
    const upload = await t.uploader.finish();
    if (!upload.ok) return { type: "failed", takeId: t.takeId, error: upload.error };
    const body = { dropped_quanta: dropped };
    if (endSec !== null) body.end_song_sec = endSec;
    const entry = await finishTake(t.jobId, t.takeId, body);
    return { type: "finished", takeId: t.takeId, entry };
  } catch (err) {
    console.warn("[recorder] take could not be finished:", err);
    return { type: "failed", takeId: t.takeId, error: String(err) };
  }
}
