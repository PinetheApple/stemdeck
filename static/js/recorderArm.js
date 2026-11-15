// Arming a track: opening its input, connecting it to the playing engine's
// context, metering it, and noticing when it stays silent or cannot be opened.
// One track is armed at a time; takes record one at a time.

import { audioEngine } from "./state.js";
import { closeInput, connectInput, inputInfo, openInput } from "./recorderCapture.js";
import { recorderPrefs, onRecorderPrefsChange } from "./recorderPrefs.js";

export const ARM_PROBLEM_SILENT = "silent";

// An armed input that never rises above this for SILENT_AFTER_MS reads as dead.
const SILENT_LEVEL = 0.0005;
const SILENT_AFTER_MS = 4000;

let armed = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn();
}

export function onArmChange(fn) {
  listeners.add(fn);
}

export function armedTrack() {
  return armed;
}

function trackChannels(track) {
  return track.input?.channels?.length ? track.input.channels : [0];
}

function attach(state) {
  const ctx = audioEngine?.audioContext;
  if (!ctx || state.input?.ctx === ctx) return;
  state.input?.disconnect();
  state.input = connectInput(ctx, state.stream);
  state.input.setMonitor(recorderPrefs().monitor);
}

/** Arm `track` of song `jobId`; resolves once its input is open or has a problem. */
export async function armTrack(jobId, track) {
  disarm();
  const state = {
    jobId,
    trackId: track.id,
    channels: trackChannels(track),
    requestedInput: track.input?.device_id || recorderPrefs().inputDeviceId,
    problem: null,
    stream: null,
    silentSince: performance.now(),
  };
  armed = state;
  notify();
  try {
    state.stream = await openInput(state.requestedInput);
  } catch (err) {
    console.warn("[recorder] input could not open:", err);
    if (armed === state) state.problem = err.problem;
    notify();
    return;
  }
  if (armed !== state) {
    closeInput(state.stream);
    return;
  }
  state.info = inputInfo(state.stream);
  attach(state);
  notify();
}

export function disarm() {
  if (!armed) return;
  armed.input?.disconnect();
  closeInput(armed.stream);
  armed = null;
  notify();
}

/** The armed input's peak level, reconnecting it if the engine changed under it. */
export function armedLevel() {
  if (!armed?.stream) return 0;
  attach(armed);
  const level = armed.input?.level() ?? 0;
  watchSilence(level);
  return level;
}

function watchSilence(level) {
  const now = performance.now();
  if (level > SILENT_LEVEL) {
    armed.silentSince = now;
    if (armed.problem === ARM_PROBLEM_SILENT) {
      armed.problem = null;
      notify();
    }
  } else if (!armed.problem && now - armed.silentSince > SILENT_AFTER_MS) {
    armed.problem = ARM_PROBLEM_SILENT;
    notify();
  }
}

onRecorderPrefsChange(function applyMonitorPref(prefs) {
  armed?.input?.setMonitor(prefs.monitor);
});
