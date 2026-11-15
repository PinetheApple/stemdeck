// Plays each recording track's active take in step with the song.
//
// Takes ride on whichever engine is playing, the way the click does: sources are
// scheduled with the engine's own sourceTimeToCtxTime into its unpitched bus, so
// they pass through the same tempo stage and master as the stems, stay at the
// key they were recorded in, and are rescheduled whenever the engine's schedule
// epoch moves (seek, loop wrap, speed change, pause).

import { audioEngine } from "./state.js";
import { createTickLoop } from "./tickLoop.js";
import { loadTakeRegion } from "./takesAudio.js";

// Far enough ahead that the first sample is never already in the past.
const SCHEDULE_LEAD_SEC = 0.05;
const GAIN_RAMP_SEC = 0.01;

/** trackId -> { takeId, url, start, end, clip, gainValue, gain, source } */
const lanes = new Map();
let engine = null;
let epoch = -1;
let running = false;
const loop = createTickLoop(tick);

function canSchedule(eng) {
  return Boolean(eng?.audioContext && eng.getMasterNode?.() && eng.sourceTimeToCtxTime && eng.getScheduleEpoch);
}

function stopLane(lane) {
  if (!lane.source) return;
  try { lane.source.stop(); } catch { /* never started */ }
  lane.source.disconnect();
  lane.source = null;
}

function stopAll() {
  for (const lane of lanes.values()) stopLane(lane);
}

function laneGain(lane) {
  if (lane.gain?.context === engine.audioContext) return lane.gain;
  lane.gain = engine.audioContext.createGain();
  lane.gain.gain.value = lane.gainValue;
  lane.gain.connect(engine.getMasterNode());
  return lane.gain;
}

// The song position the sources will have reached SCHEDULE_LEAD_SEC from now;
// during a count-in that is still before the start, which getCurrentTime holds.
function scheduleFrom() {
  const ahead = engine.ctxTimeToSourceTime(engine.audioContext.currentTime + SCHEDULE_LEAD_SEC);
  return Math.max(engine.getCurrentTime(), ahead);
}

function sourceRate() {
  const at = engine.audioContext.currentTime;
  return engine.ctxTimeToSourceTime(at + 1) - engine.ctxTimeToSourceTime(at);
}

function startLane(lane, from) {
  const { clip } = lane;
  if (!clip) return;
  const clipEnd = clip.startSec + clip.buffer.duration;
  if (from >= clipEnd) return;
  const begin = Math.max(clip.startSec, from);
  const source = engine.audioContext.createBufferSource();
  source.buffer = clip.buffer;
  source.playbackRate.value = sourceRate();
  source.connect(laneGain(lane));
  source.start(engine.sourceTimeToCtxTime(begin), begin - clip.startSec);
  lane.source = source;
}

function scheduleAll() {
  stopAll();
  const from = scheduleFrom();
  for (const lane of lanes.values()) startLane(lane, from);
}

function rebind(next) {
  stopAll();
  for (const lane of lanes.values()) lane.gain = null;
  engine = canSchedule(next) ? next : null;
  epoch = -1;
  running = false;
}

function tick() {
  loop.schedule();
  if (audioEngine !== engine) rebind(audioEngine);
  if (!engine) return;
  const ready = engine.isPlaying() && engine.isClockReady();
  const now = engine.getScheduleEpoch();
  if (ready && (!running || now !== epoch)) scheduleAll();
  else if (!ready && running) stopAll();
  running = ready;
  epoch = now;
}

async function loadClip(lane) {
  try {
    lane.clip = await loadTakeRegion(lane.url, lane.start, lane.end);
  } catch (err) {
    console.warn("[takes] take audio could not load:", err);
    return;
  }
  if (running && lanes.get(lane.trackId) === lane) startLane(lane, scheduleFrom());
}

function laneFor(track) {
  const { entry } = track;
  return {
    trackId: track.trackId,
    takeId: entry.id,
    url: entry.url,
    start: Math.max(0, entry.placement_sec),
    end: entry.placement_sec + entry.duration_sec,
    clip: null,
    gainValue: lanes.get(track.trackId)?.gainValue ?? 1,
    gain: null,
    source: null,
  };
}

/**
 * The takes to play, one per track: `[{trackId, entry}]` with each track's
 * active take entry. Unchanged lanes keep their loaded audio.
 */
export function setTakeLanes(tracks) {
  if (audioEngine !== engine) rebind(audioEngine);
  const wanted = new Map(tracks.map((track) => [track.trackId, track]));
  for (const [trackId, lane] of lanes) {
    if (wanted.get(trackId)?.entry.id === lane.takeId) continue;
    stopLane(lane);
    lane.gain?.disconnect();
    lanes.delete(trackId);
  }
  for (const track of wanted.values()) {
    if (lanes.has(track.trackId)) continue;
    const lane = laneFor(track);
    lanes.set(track.trackId, lane);
    loadClip(lane);
  }
  loop.schedule();
}

export function setTakeLaneGain(trackId, value) {
  const lane = lanes.get(trackId);
  if (!lane) return;
  lane.gainValue = value;
  lane.gain?.gain.setTargetAtTime(value, lane.gain.context.currentTime, GAIN_RAMP_SEC);
}

export function clearTakeLanes() {
  setTakeLanes([]);
  loop.cancel();
}
