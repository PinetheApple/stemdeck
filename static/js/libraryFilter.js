import { SONG_FIELDS } from "./songFields.js";

export const KEY_MODES = Object.freeze({ MAJOR: "major", MINOR: "minor" });
export const SLOW_MAX_BPM = 90;
export const FAST_MIN_BPM = 130;
export const TEMPO_BANDS = Object.freeze({ SLOW: "slow", MEDIUM: "medium", FAST: "fast" });
export const DEFAULT_FILTERS = Object.freeze({ favoritesOnly: false, tempo: null, mode: null });

export const TEMPO_OPTIONS = Object.freeze([
  { value: null, label: "libSort.anyTempo" },
  { value: TEMPO_BANDS.SLOW, label: "libSort.tempoSlow", vars: { max: SLOW_MAX_BPM } },
  { value: TEMPO_BANDS.MEDIUM, label: "libSort.tempoMedium", vars: { min: SLOW_MAX_BPM, max: FAST_MIN_BPM } },
  { value: TEMPO_BANDS.FAST, label: "libSort.tempoFast", vars: { min: FAST_MIN_BPM } },
]);
export const KEY_MODE_OPTIONS = Object.freeze([
  { value: null, label: "libSort.anyKey" },
  { value: KEY_MODES.MAJOR, label: "libSort.majorKeys" },
  { value: KEY_MODES.MINOR, label: "libSort.minorKeys" },
]);

const NATURAL_PITCHES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTALS = { "": 0, "#": 1, "♯": 1, b: -1, "♭": -1 };
const PITCH_CLASSES = 12;
const TONIC = /^([A-G])([#♯b♭]?)$/;
const MAJOR_WORD = /^maj/i;
const MINOR_WORD = /^min|minor/i;

function modeOf(suffix, scale) {
  if (MAJOR_WORD.test(suffix)) return KEY_MODES.MAJOR;
  if (MINOR_WORD.test(suffix)) return KEY_MODES.MINOR;
  if (MINOR_WORD.test(scale)) return KEY_MODES.MINOR;
  return MAJOR_WORD.test(scale) ? KEY_MODES.MAJOR : null;
}

export function songKey(song) {
  const [tonic = "", suffix = ""] = (SONG_FIELDS.key(song) ?? "").split(/\s+/);
  const match = TONIC.exec(tonic);
  const mode = modeOf(suffix, SONG_FIELDS.scale(song) ?? "");
  if (!match || !mode) return null;
  const pitch = (NATURAL_PITCHES[match[1]] + ACCIDENTALS[match[2]] + PITCH_CLASSES) % PITCH_CLASSES;
  return { pitch, mode };
}

const IN_BAND = {
  [TEMPO_BANDS.SLOW]: (bpm) => bpm < SLOW_MAX_BPM,
  [TEMPO_BANDS.MEDIUM]: (bpm) => bpm >= SLOW_MAX_BPM && bpm <= FAST_MIN_BPM,
  [TEMPO_BANDS.FAST]: (bpm) => bpm > FAST_MIN_BPM,
};

function keepsTempo(song, band) {
  if (!band) return true;
  const bpm = SONG_FIELDS.tempo(song);
  return bpm !== null && IN_BAND[band](bpm);
}

function keepsMode(song, mode) {
  return !mode || songKey(song)?.mode === mode;
}

export function filterSongs(songs, { favoritesOnly, tempo, mode } = DEFAULT_FILTERS, isFavorite) {
  return songs.filter(
    (song) => (!favoritesOnly || isFavorite(song)) && keepsTempo(song, tempo) && keepsMode(song, mode),
  );
}

export function activeFilterCount({ favoritesOnly, tempo, mode }) {
  return [favoritesOnly, tempo, mode].filter(Boolean).length;
}

export function clearFilters() {
  return { ...DEFAULT_FILTERS };
}
