import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FILTERS,
  FAST_MIN_BPM,
  KEY_MODES,
  SLOW_MAX_BPM,
  TEMPO_BANDS,
  TEMPO_OPTIONS,
  activeFilterCount,
  clearFilters,
  filterSongs,
} from "../../static/js/libraryFilter.js";

const BAND_EDGES = [SLOW_MAX_BPM - 1, SLOW_MAX_BPM, FAST_MIN_BPM, FAST_MIN_BPM + 1];
const TEMPO_SONGS = [...BAND_EDGES.map((bpm) => ({ id: String(bpm), bpm })), { id: "noBpm", bpm: null }];
const KEY_SONGS = [
  { id: "cMajor", key: "C maj" },
  { id: "aMinor", key: "A min" },
  { id: "fSharpHarmonic", key: "F# min", scale: "Harmonic Minor" },
  { id: "eByScale", key: "E", scale: "Natural Minor" },
  { id: "gByScale", key: "G", scale: "Major" },
  { id: "noKey", key: null },
];
const FAVORITE_IDS = new Set(["cMajor"]);
const isFavorite = (song) => FAVORITE_IDS.has(song.id);

const keptIds = (songs, filters) => filterSongs(songs, { ...DEFAULT_FILTERS, ...filters }, isFavorite).map((song) => song.id);

test("the tempo bands meet at 90 and 130, both in medium", () => {
  assert.equal(SLOW_MAX_BPM, 90);
  assert.equal(FAST_MIN_BPM, 130);
  assert.deepEqual(keptIds(TEMPO_SONGS, { tempo: TEMPO_BANDS.SLOW }), ["89"]);
  assert.deepEqual(keptIds(TEMPO_SONGS, { tempo: TEMPO_BANDS.MEDIUM }), ["90", "130"]);
  assert.deepEqual(keptIds(TEMPO_SONGS, { tempo: TEMPO_BANDS.FAST }), ["131"]);
});

test("the tempo labels take their limits from the band constants", () => {
  const varsOf = (band) => TEMPO_OPTIONS.find((option) => option.value === band).vars;
  assert.deepEqual(varsOf(TEMPO_BANDS.SLOW), { max: SLOW_MAX_BPM });
  assert.deepEqual(varsOf(TEMPO_BANDS.MEDIUM), { min: SLOW_MAX_BPM, max: FAST_MIN_BPM });
  assert.deepEqual(varsOf(TEMPO_BANDS.FAST), { min: FAST_MIN_BPM });
});

test("a song without a tempo shows until a tempo band is picked", () => {
  assert.ok(keptIds(TEMPO_SONGS, {}).includes("noBpm"));
});

test("the key filter keeps major or minor keys and drops songs without a key", () => {
  assert.deepEqual(keptIds(KEY_SONGS, { mode: KEY_MODES.MAJOR }), ["cMajor", "gByScale"]);
  assert.deepEqual(keptIds(KEY_SONGS, { mode: KEY_MODES.MINOR }), ["aMinor", "fSharpHarmonic", "eByScale"]);
  assert.deepEqual(keptIds(KEY_SONGS, {}), KEY_SONGS.map((song) => song.id));
});

test("favorites only keeps favorites, and filters combine", () => {
  assert.deepEqual(keptIds(KEY_SONGS, { favoritesOnly: true }), ["cMajor"]);
  assert.deepEqual(keptIds(KEY_SONGS, { favoritesOnly: true, mode: KEY_MODES.MINOR }), []);
});

test("the count names how many filters are on", () => {
  assert.equal(activeFilterCount(DEFAULT_FILTERS), 0);
  assert.equal(activeFilterCount({ ...DEFAULT_FILTERS, favoritesOnly: true }), 1);
  assert.equal(activeFilterCount({ favoritesOnly: true, tempo: TEMPO_BANDS.FAST, mode: KEY_MODES.MINOR }), 3);
});

test("clearing gives a fresh copy of the defaults", () => {
  const cleared = clearFilters();
  assert.deepEqual(cleared, DEFAULT_FILTERS);
  assert.notEqual(cleared, DEFAULT_FILTERS);
  assert.equal(activeFilterCount(cleared), 0);
});
