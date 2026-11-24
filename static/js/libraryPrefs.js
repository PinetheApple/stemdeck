// The library's sort and filters, kept on this device (#235).

import { storeGet, storeSet } from "./utils.js";
import { DEFAULT_SORT, DIRECTIONS, SORT_KEYS } from "./librarySort.js";
import { DEFAULT_FILTERS, KEY_MODES, TEMPO_BANDS } from "./libraryFilter.js";

export const LIBRARY_VIEW_KEY = "stemdeck.library.view";

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const oneOf = (allowed, value, fallback) => (Object.values(allowed).includes(value) ? value : fallback);

function readFilters(stored) {
  const filters = isRecord(stored) ? stored : {};
  return {
    favoritesOnly: filters.favoritesOnly === true,
    tempo: oneOf(TEMPO_BANDS, filters.tempo, DEFAULT_FILTERS.tempo),
    mode: oneOf(KEY_MODES, filters.mode, DEFAULT_FILTERS.mode),
  };
}

/** The saved view, each unknown or unreadable value replaced by its default. */
export async function loadLibraryView() {
  const stored = await storeGet(LIBRARY_VIEW_KEY, null);
  const view = isRecord(stored) ? stored : {};
  return {
    sort: oneOf(SORT_KEYS, view.sort, DEFAULT_SORT.sort),
    dir: oneOf(DIRECTIONS, view.dir, DEFAULT_SORT.dir),
    filters: readFilters(view.filters),
  };
}

export function saveLibraryView({ sort, dir, filters }) {
  return storeSet(LIBRARY_VIEW_KEY, { sort, dir, filters });
}
