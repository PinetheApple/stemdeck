// Film view timing, pure so node can test it: the camera's first frame against
// the first audio frame (docs/takes.md "Filmed takes"), and the trim handles.

export const CLOCK_CAPTURE = "capture";
export const CLOCK_RECORDER_START = "recorder-start";
// The server refuses a finish beyond this; the take then keeps its sound alone.
export const FIRST_FRAME_OFFSET_MAX_MS = 10_000;
export const TRIM_MIN_SEC = 1;
export const TRIM_IN = "in";
export const TRIM_OUT = "out";

const MS_PER_SEC = 1000;

/** A performance.now() time on the audio context's clock, from ctx.getOutputTimestamp(). */
export function perfToCtxSec(perfMs, stamp) {
  return stamp.contextTime + (perfMs - stamp.performanceTime) / MS_PER_SEC;
}

/**
 * The finish body's camera timing, or null when it cannot be told.
 * `captureMs` is the first frame's captureTime, `startMs` the recorder's start
 * event, both performance times; `c0` the first audio frame's context time.
 */
export function cameraTiming({ captureMs, startMs, stamp, c0 }) {
  if (c0 === null || c0 === undefined || !stamp) return null;
  const frameMs = captureMs ?? startMs;
  if (frameMs === null || frameMs === undefined) return null;
  const offsetMs = (perfToCtxSec(frameMs, stamp) - c0) * MS_PER_SEC;
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > FIRST_FRAME_OFFSET_MAX_MS) return null;
  return {
    first_frame_offset_ms: offsetMs,
    first_frame_clock: captureMs === null || captureMs === undefined ? CLOCK_RECORDER_START : CLOCK_CAPTURE,
  };
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function songFraction(sec, songSec) {
  if (!(songSec > 0)) return 0;
  return clamp01(sec / songSec);
}

export function secAtFraction(fraction, songSec) {
  return clamp01(fraction) * songSec;
}

/**
 * The trim after dragging `edge` to `sec`: inside the take's span and at least
 * TRIM_MIN_SEC long. Null when the handles are back at the span's edges, or the
 * span is too short to trim.
 */
export function dragTrim({ span, trim, edge, sec }) {
  const { start_sec: start, end_sec: end } = span;
  if (end - start < TRIM_MIN_SEC) return null;
  let inSec = trim?.in_sec ?? start;
  let outSec = trim?.out_sec ?? end;
  if (edge === TRIM_IN) inSec = Math.min(Math.max(start, sec), outSec - TRIM_MIN_SEC);
  else outSec = Math.max(Math.min(end, sec), inSec + TRIM_MIN_SEC);
  if (inSec <= start && outSec >= end) return null;
  return { in_sec: inSec, out_sec: outSec };
}

const ORIGINAL = "original";

/** The song's waveform for the timeline: the original's peaks, else the loudest stem at each point. */
export function mergePeaks(peaksByStem) {
  if (!peaksByStem || typeof peaksByStem !== "object") return [];
  if (Array.isArray(peaksByStem[ORIGINAL])) return peaksByStem[ORIGINAL];
  const merged = [];
  for (const points of Object.values(peaksByStem)) {
    if (!Array.isArray(points)) continue;
    points.forEach(function mergePoint([low, high], i) {
      const amp = Math.max(Math.abs(low), Math.abs(high), merged[i]?.[1] ?? 0);
      merged[i] = [-amp, amp];
    });
  }
  return merged;
}
