// Library filters (#235): favorites, a tempo band and major or minor keys.

import { KEY_MODES, SONG_FIELDS, songKey } from "./librarySort.js";

export { KEY_MODES };

export const SLOW_MAX_BPM = 90;
export const FAST_MIN_BPM = 130;
export const TEMPO_BANDS = Object.freeze({ SLOW: "slow", MEDIUM: "medium", FAST: "fast" });
export const DEFAULT_FILTERS = Object.freeze({ favoritesOnly: false, tempo: null, mode: null });

export const TEMPO_OPTIONS = Object.freeze([
  { value: null, label: "libSort.anyTempo" },
  { value: TEMPO_BANDS.SLOW, label: "libSort.tempoSlow" },
  { value: TEMPO_BANDS.MEDIUM, label: "libSort.tempoMedium" },
  { value: TEMPO_BANDS.FAST, label: "libSort.tempoFast" },
]);
export const KEY_MODE_OPTIONS = Object.freeze([
  { value: null, label: "libSort.anyKey" },
  { value: KEY_MODES.MAJOR, label: "libSort.majorKeys" },
  { value: KEY_MODES.MINOR, label: "libSort.minorKeys" },
]);

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

/** The songs every filter that is on lets through; a filter that is off keeps songs without its value. */
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
