// One take from Record to finish. Capture starts on the press so a pickup note is
// kept; anything that takes the song away stops the take and finishes it on its own song.

import { audioEngine, currentJobId, playbackSpeed } from "./state.js";
import { createTickLoop } from "./tickLoop.js";
import { startCapture } from "./recorderCapture.js";
import { createPartUploader, TAKE_PART_SEC, UPLOAD_ERROR } from "./recorderParts.js";
import { songTimeAtCtx } from "./recorderTiming.js";
import { armedTrack, setArmProblem } from "./recorderArm.js";
import { savedRoundTrip, takeLatency } from "./latencyStore.js";
import { createTake, finishTake, readParts, sendPart } from "./takesApi.js";

export const REC_PHASE = { counting: "counting", recording: "recording", finishing: "finishing" };
export const RECORD_BLOCK = { speed: "speed", noTrack: "noTrack", noInput: "noInput", noEngine: "noEngine" };
export const STOP_REASON = { user: "user", transport: "transport", switched: "switched" };
export const ARM_PROBLEM_START_FAILED = "startFailed";
export const ARM_PROBLEM_SAVE_FAILED = "saveFailed";
export const NORMAL_SPEED = 1;

const SPEED_TOLERANCE = 1e-6;
// getCurrentTime is held at the start position until the song has moved past it.
const CLOCK_SETTLE_SEC = 0.05;
const TEARDOWN_WAIT_MS = 500;
// How long "Saving…" holds Record before it offers to discard what has not arrived.
const SAVING_DISCARD_AFTER_MS = 10_000;
// The server will never take these parts; the track says so instead of a notice.
const LOST_UPLOAD = new Set([UPLOAD_ERROR.gone, UPLOAD_ERROR.refused]);

/** True when the server will never have the take, so it is not left as unfinished either. */
export function isLostUpload(error) {
  return LOST_UPLOAD.has(error);
}

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
  return { jobId, trackId, takeId, phase, startSec: frame0 ?? startPos, peaks, canDiscard: canDiscard(take) };
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
  if (take?.phase === REC_PHASE.finishing) return discardSaving(take);
  if (take) return stopTake(STOP_REASON.user);
  if (recordBlock()) return null;
  const eng = audioEngine;
  const arm = armedTrack();
  const t = newTake(eng, arm, label);
  take = t;
  if (!eng.isPlaying()) countIn();
  emit({ type: "change" });
  const capture = await openCapture(t, arm);
  if (!capture) return null;
  // Stop was pressed while the worklet was still loading.
  if (take !== t) {
    await capture.stop();
    return null;
  }
  t.capture = capture;
  loop.schedule();
  return t;
}

async function openCapture(t, arm) {
  try {
    return await startCapture(arm.input, arm.channels, { onStart: onCaptureStart, onAudio: onCaptureAudio });
  } catch (err) {
    console.warn("[recorder] capture could not start:", err);
    if (take === t) take = null;
    emit({ type: "change" });
    return null;
  }
}

function canDiscard(t) {
  return t.phase === REC_PHASE.finishing && performance.now() - t.finishingSince > SAVING_DISCARD_AFTER_MS;
}

/** Give up on a save stuck behind a server that does not answer; Record is free again at once. */
function discardSaving(t) {
  if (!canDiscard(t)) return null;
  t.discarded = true;
  t.uploader?.discard();
  if (take === t) take = null;
  emit({ type: "change" });
  emit({ type: "failed", jobId: t.jobId, trackId: t.trackId, takeId: t.takeId, error: UPLOAD_ERROR.discarded });
  return null;
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
  if (!eng.isPlaying() || eng.getScheduleEpoch() !== take.epoch || take.uploader?.status().error) {
    stopTake(STOP_REASON.transport);
  }
}

function clockRunning(eng) {
  return eng.isClockReady() && eng.getCurrentTime() > take.startPos + CLOCK_SETTLE_SEC;
}

function beginTake(eng) {
  const now = eng.audioContext.currentTime;
  const frame0 = songTimeAtCtx(eng.ctxTimeToSourceTime, now, eng.getCurrentTime(), take.c0);
  take.frame0 = frame0;
  take.phase = REC_PHASE.recording;
  take.epoch = eng.getScheduleEpoch();
  const t = take;
  take.created = createOnServer(t, frame0).catch(function onCreateFailed(err) {
    return abandonTake(t, err);
  });
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

/** The server refused the take: drop what was captured and leave the track armed with the reason. */
async function abandonTake(t, err) {
  console.warn("[recorder] take could not be started:", err);
  t.pending.length = 0;
  if (take === t) take = null;
  await t.capture?.stop();
  setArmProblem(t.trackId, ARM_PROBLEM_START_FAILED);
  emit({ type: "change" });
  return null;
}

function createUploader(t) {
  return createPartUploader(
    {
      send: function sendTakePart(seq, bytes, signal) {
        return sendPart(t.jobId, t.takeId, seq, bytes, signal);
      },
      readState: function readTakeParts() {
        return readParts(t.jobId, t.takeId);
      },
      wait: function waitBeforeRetry(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
    },
    { partSamples: Math.round(t.rate * TAKE_PART_SEC) * t.channels.length, channels: t.channels.length },
  );
}

function endSongSec(t) {
  if (songChanged(t)) return null;
  return t.engine.getCurrentTime();
}

/**
 * Stop capture, then keep the take in the "finishing" phase until every part
 * has reached the server and it is finished on its own song.
 */
export async function stopTake(reason) {
  const t = take;
  if (!t || t.phase === REC_PHASE.finishing) return null;
  const wasRecording = t.phase === REC_PHASE.recording;
  t.phase = REC_PHASE.finishing;
  t.finishingSince = performance.now();
  const endSec = endSongSec(t);
  emit({ type: "change" });
  t.captureStopped = t.capture?.stop() ?? Promise.resolve(0);
  const dropped = await t.captureStopped;
  const outcome = wasRecording ? await finishOnServer(t, endSec, dropped ?? 0) : null;
  if (take === t) take = null;
  if (isLostUpload(outcome?.error)) setArmProblem(t.trackId, ARM_PROBLEM_SAVE_FAILED);
  emit({ type: "change" });
  if (outcome && !t.discarded) emit({ ...outcome, jobId: t.jobId, trackId: t.trackId, reason });
  return outcome;
}

/**
 * Before the engine is torn down (song switch, Up Next, engine swap): stop the
 * take while its context still runs, so the last captured audio is kept. Waits
 * for capture only, at most TEARDOWN_WAIT_MS; uploading carries on afterwards.
 */
export async function finishTakeBeforeTeardown() {
  const t = take;
  if (!t || t.phase === REC_PHASE.finishing) return;
  stopTake(STOP_REASON.switched);
  const timeout = new Promise((resolve) => setTimeout(resolve, TEARDOWN_WAIT_MS));
  await Promise.race([t.captureStopped, timeout]);
}

async function finishOnServer(t, endSec, dropped) {
  if (!(await t.created)) return null;
  if (t.discarded) {
    t.uploader.discard();
    return { type: "failed", takeId: t.takeId, error: UPLOAD_ERROR.discarded };
  }
  try {
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

// A take still recording or saving would be cut off; the browser asks first.
globalThis.addEventListener?.("beforeunload", function onLeaveWhileRecording(e) {
  if (!take) return;
  e.preventDefault();
  e.returnValue = "";
});
