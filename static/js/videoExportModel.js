// The filmed-take export, pure: the render request, the dialog state for each
// render view (docs/takes.md "Video export"), and the names it shows.

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

const STATUS_PHASE = {
  none: EXPORT_PHASE.options,
  cancelled: EXPORT_PHASE.options,
  queued: EXPORT_PHASE.waiting,
  running: EXPORT_PHASE.running,
  done: EXPORT_PHASE.done,
  error: EXPORT_PHASE.failed,
};
const ERROR_DISK_FULL = "disk-full";
const CPU_ENCODER = "libx264";
const ENCODER_LABELS = {
  h264_nvenc: "NVENC",
  h264_vaapi: "VAAPI",
  h264_qsv: "QSV",
  h264_amf: "AMF",
  h264_videotoolbox: "VideoToolbox",
  [CPU_ENCODER]: "CPU",
};
const PERCENT = 100;
const MS_PER_MIN = 60_000;
const FILE_NAME_MAX = 80;

/** Stored size and fps, each falling back on its own when the server would refuse it. */
export function exportPrefs(stored) {
  const size = RENDER_SIZES.includes(stored?.size) ? stored.size : DEFAULT_EXPORT_PREFS.size;
  const fps = RENDER_FPS.includes(stored?.fps) ? stored.fps : DEFAULT_EXPORT_PREFS.fps;
  return { size, fps };
}

/** RenderBody from the export mix's lanes, without the filmed take's own track. */
export function renderBody({ lanes, takeTrackId, prefs }) {
  const keep = lanes.names.map((name, i) => i).filter((i) => lanes.names[i] !== takeTrackId);
  const body = {
    stems: keep.map((i) => lanes.names[i]),
    gains: keep.map((i) => lanes.gains[i]),
    size: prefs.size,
    fps: prefs.fps,
  };
  const pitches = keep.map((i) => lanes.pitches?.[i] ?? 0);
  if (pitches.some((p) => p !== 0)) body.pitches = pitches;
  return body;
}

export function encoderLabel(encoder) {
  return ENCODER_LABELS[encoder] ?? encoder;
}

/** What the dialog shows for a render view. */
export function exportState(view) {
  const phase = STATUS_PHASE[view?.status] ?? EXPORT_PHASE.options;
  return {
    phase,
    percent: Math.round((view?.progress ?? 0) * PERCENT),
    encoder: view?.encoder ? encoderLabel(view.encoder) : null,
    cpuFallback: view?.encoder === CPU_ENCODER && Boolean(view?.fallback_reason),
    diskFull: phase === EXPORT_PHASE.failed && view?.error === ERROR_DISK_FULL,
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
