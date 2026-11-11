// No DOM here, so node can test it.

const NORMAL_RATE = 1;
const MS_PER_SEC = 1000;

// The OS extrapolates the position from the last report; a gap this large
// means the playhead moved some other way, a seek or a loop wrap.
export const POSITION_DRIFT_SEC = 0.5;

/** The MediaMetadata init for a song, or null when it has no title to show. */
export function metadataInit({ title, artist, album, artwork }) {
  if (!title) return null;
  return {
    title,
    artist: artist || "",
    album: album || "",
    artwork: artwork ? [{ src: artwork }] : [],
  };
}

/**
 * A position state setPositionState() accepts, or null when the duration is
 * not known yet; the browser throws on anything else.
 */
export function positionStateFor({ duration, position, rate }) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const at = Number.isFinite(position) ? position : 0;
  return {
    duration,
    position: Math.min(duration, Math.max(0, at)),
    playbackRate: Number.isFinite(rate) && rate > 0 ? rate : NORMAL_RATE,
  };
}

/** True when the OS's idea of the position, rate or play state is out of date. */
export function positionDrifted(reported, next, playing, nowMs) {
  if (!reported) return true;
  const { state, atMs } = reported;
  if (reported.playing !== playing) return true;
  if (state.duration !== next.duration || state.playbackRate !== next.playbackRate) return true;
  const elapsed = playing ? ((nowMs - atMs) / MS_PER_SEC) * state.playbackRate : 0;
  const expected = Math.min(state.duration, state.position + elapsed);
  return Math.abs(expected - next.position) > POSITION_DRIFT_SEC;
}

export const STILL = Object.freeze({ from: null, moving: false });

/**
 * Whether the playhead has moved since play started. A count-in plays with the
 * playhead held, and the OS must not advance it until the audio starts.
 */
export function nextMotion(motion, playing, position) {
  if (!playing) return STILL;
  if (motion.from === null) return { from: position, moving: false };
  if (motion.moving || position === motion.from) return motion;
  return { from: motion.from, moving: true };
}
