import { PERCENT } from "./stageModel.js";
import { CPU_ENCODER, encoderName } from "./videoEncoderModel.js";

export const RENDER_SIZES = ["720", "1080"];
export const RENDER_FPS = [24, 30, 60];
export const DEFAULT_EXPORT_PREFS = Object.freeze({ size: "1080", fps: 30 });

export const EXPORT_PHASE = {
  options: "options",
  waiting: "waiting",
  running: "running",
  done: "done",
  failed: "failed",
};

export const RENDER_STATUS = {
  none: "none",
  cancelled: "cancelled",
  queued: "queued",
  running: "running",
  done: "done",
  error: "error",
};

export const RENDER_ERROR = {
  diskFull: "disk-full",
  failed: "failed",
  // The dialog's own: the server stopped answering the progress reads.
  noAnswer: "no-answer",
};

const STATUS_PHASE = {
  [RENDER_STATUS.none]: EXPORT_PHASE.options,
  [RENDER_STATUS.cancelled]: EXPORT_PHASE.options,
  [RENDER_STATUS.queued]: EXPORT_PHASE.waiting,
  [RENDER_STATUS.running]: EXPORT_PHASE.running,
  [RENDER_STATUS.done]: EXPORT_PHASE.done,
  [RENDER_STATUS.error]: EXPORT_PHASE.failed,
};
const MS_PER_MIN = 60_000;
const FILE_NAME_MAX = 80;

/** A render view that failed with `error`, one of RENDER_ERROR. */
export function failedView(error) {
  return { status: RENDER_STATUS.error, error };
}

/** Stored size and fps, each falling back on its own when the server would refuse it. */
export function exportPrefs(stored) {
  const size = RENDER_SIZES.includes(stored?.size) ? stored.size : DEFAULT_EXPORT_PREFS.size;
  const fps = RENDER_FPS.includes(stored?.fps) ? stored.fps : DEFAULT_EXPORT_PREFS.fps;
  return { size, fps };
}

/** RenderBody from the export mix's lanes, without the filmed take's own track, and the stems the player plays. */
export function renderBody({ lanes, takeTrackId, prefs, iPlay }) {
  const keep = lanes.names.map((name, i) => i).filter((i) => lanes.names[i] !== takeTrackId);
  const body = {
    stems: keep.map((i) => lanes.names[i]),
    gains: keep.map((i) => lanes.gains[i]),
    i_play: [...iPlay],
    size: prefs.size,
    fps: prefs.fps,
  };
  const pitches = keep.map((i) => lanes.pitches?.[i] ?? 0);
  if (pitches.some((p) => p !== 0)) body.pitches = pitches;
  return body;
}

/** What the dialog shows for a render view. */
export function exportState(view) {
  const phase = STATUS_PHASE[view?.status] ?? EXPORT_PHASE.options;
  const progress = view?.progress ?? 0;
  const failedWith = (error) => phase === EXPORT_PHASE.failed && view?.error === error;
  return {
    phase,
    progress,
    percent: Math.round(progress * PERCENT),
    encoder: view?.encoder ? encoderName(view.encoder) : null,
    cpuFallback: view?.encoder === CPU_ENCODER && Boolean(view?.fallback_reason),
    diskFull: failedWith(RENDER_ERROR.diskFull),
    noAnswer: failedWith(RENDER_ERROR.noAnswer),
  };
}

/** Whole minutes left at the rate so far, at least one; null before any progress. */
export function minutesLeft(progress, elapsedMs) {
  if (!(progress > 0)) return null;
  const leftMs = (elapsedMs * (1 - progress)) / progress;
  return Math.max(1, Math.ceil(leftMs / MS_PER_MIN));
}

const slug = (text) => String(text || "")
  .replace(/[^a-zA-Z0-9]+/g, "_")
  .replace(/_{2,}/g, "_")
  .slice(0, FILE_NAME_MAX)
  .replace(/^_+|_+$/g, "");

export function videoFilename(title, label) {
  return `${[slug(title), slug(label)].filter(Boolean).join("_")}.mp4`;
}
