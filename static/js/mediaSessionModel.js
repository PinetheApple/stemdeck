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

/**
 * Whether the OS play key toggles the transport. The OS reads a count-in as
 * paused, so the key cancels it, as the toggle does; a start still waiting on
 * its first audio is left to land.
 */
export function playKeyStarts({ playing, moving, clockReady }) {
  return !playing || (!moving && clockReady);
}

export const WAV_CHUNK = Object.freeze({ RIFF: "RIFF", WAVE: "WAVE", FMT: "fmt ", DATA: "data" });

/** Byte offsets of the canonical 44-byte PCM WAV header. */
export const WAV_FIELD = Object.freeze({
  RIFF_ID: 0,
  RIFF_SIZE: 4,
  WAVE_ID: 8,
  FMT_ID: 12,
  FMT_SIZE: 16,
  FORMAT: 20,
  CHANNELS: 22,
  SAMPLE_RATE: 24,
  BYTE_RATE: 28,
  BLOCK_ALIGN: 32,
  BITS_PER_SAMPLE: 34,
  DATA_ID: 36,
  DATA_SIZE: 40,
});

export const WAV_HEADER_BYTES = 44;
export const PCM_FORMAT = 1;
export const MONO = 1;
export const BITS_PER_SAMPLE = 16;
export const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const RIFF_SIZE_EXCLUDES = WAV_FIELD.WAVE_ID;
const FMT_CHUNK_BYTES = WAV_FIELD.DATA_ID - WAV_FIELD.FORMAT;

function writeAscii(view, at, text) {
  [...text].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
}

/** A 16-bit mono PCM WAV of digital silence. */
export function silentWav(seconds, sampleRate) {
  const dataBytes = Math.round(seconds * sampleRate) * BYTES_PER_SAMPLE;
  const bytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, WAV_FIELD.RIFF_ID, WAV_CHUNK.RIFF);
  view.setUint32(WAV_FIELD.RIFF_SIZE, bytes.length - RIFF_SIZE_EXCLUDES, true);
  writeAscii(view, WAV_FIELD.WAVE_ID, WAV_CHUNK.WAVE);
  writeAscii(view, WAV_FIELD.FMT_ID, WAV_CHUNK.FMT);
  view.setUint32(WAV_FIELD.FMT_SIZE, FMT_CHUNK_BYTES, true);
  view.setUint16(WAV_FIELD.FORMAT, PCM_FORMAT, true);
  view.setUint16(WAV_FIELD.CHANNELS, MONO, true);
  view.setUint32(WAV_FIELD.SAMPLE_RATE, sampleRate, true);
  view.setUint32(WAV_FIELD.BYTE_RATE, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(WAV_FIELD.BLOCK_ALIGN, BYTES_PER_SAMPLE, true);
  view.setUint16(WAV_FIELD.BITS_PER_SAMPLE, BITS_PER_SAMPLE, true);
  writeAscii(view, WAV_FIELD.DATA_ID, WAV_CHUNK.DATA);
  view.setUint32(WAV_FIELD.DATA_SIZE, dataBytes, true);
  return bytes;
}
