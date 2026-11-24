// Library view prefs (#235): sort and filters kept on this device, bad values ignored.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const stored = new Map();
globalThis.window = {};
globalThis.localStorage = {
  getItem: (key) => (stored.has(key) ? stored.get(key) : null),
  setItem: (key, value) => stored.set(key, String(value)),
};

const { LIBRARY_VIEW_KEY, loadLibraryView, saveLibraryView } = await import("../../static/js/libraryPrefs.js");
const { DEFAULT_SORT, DIRECTIONS, SORT_KEYS } = await import("../../static/js/librarySort.js");
const { DEFAULT_FILTERS, KEY_MODES, TEMPO_BANDS } = await import("../../static/js/libraryFilter.js");

const DEFAULT_VIEW = { ...DEFAULT_SORT, filters: DEFAULT_FILTERS };
const storeRaw = (value) => stored.set(LIBRARY_VIEW_KEY, value);

beforeEach(() => stored.clear());

test("the key sits under stemdeck.library", () => {
  assert.ok(LIBRARY_VIEW_KEY.startsWith("stemdeck.library."));
});

test("nothing saved gives the defaults", async () => {
  assert.deepEqual(await loadLibraryView(), DEFAULT_VIEW);
});

test("a saved view comes back", async () => {
  const view = {
    sort: SORT_KEYS.TEMPO,
    dir: DIRECTIONS.ASC,
    filters: { favoritesOnly: true, tempo: TEMPO_BANDS.FAST, mode: KEY_MODES.MINOR },
  };
  assert.equal(await saveLibraryView(view), true);
  assert.deepEqual(await loadLibraryView(), view);
});

test("unreadable stored text gives the defaults", async () => {
  storeRaw("{not json");
  assert.deepEqual(await loadLibraryView(), DEFAULT_VIEW);
});

test("stored values of the wrong shape give the defaults", async () => {
  for (const value of [5, "title", [], null]) {
    storeRaw(JSON.stringify(value));
    assert.deepEqual(await loadLibraryView(), DEFAULT_VIEW, JSON.stringify(value));
  }
});

test("each unknown field falls back on its own default", async () => {
  storeRaw(JSON.stringify({
    sort: SORT_KEYS.KEY,
    dir: "sideways",
    filters: { favoritesOnly: "yes", tempo: "glacial", mode: KEY_MODES.MAJOR },
  }));
  assert.deepEqual(await loadLibraryView(), {
    sort: SORT_KEYS.KEY,
    dir: DEFAULT_SORT.dir,
    filters: { ...DEFAULT_FILTERS, mode: KEY_MODES.MAJOR },
  });
});
