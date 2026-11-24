import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrangeIds,
  filtersHideAll,
  isArrangedView,
  movedIdsFor,
  selectScopeOf,
  showsMyOrder,
} from "../../static/js/libraryArrange.js";
import { VIEW } from "../../static/js/browseViewNames.js";
import { DIRECTIONS, SORT_KEYS } from "../../static/js/librarySort.js";
import { DEFAULT_FILTERS, FAST_MIN_BPM, SLOW_MAX_BPM, TEMPO_BANDS } from "../../static/js/libraryFilter.js";
import { BULK_ACTION, SELECTION_SCOPES, bulkTargets } from "../../static/js/librarySelection.js";
import { myOrderAfterMove } from "../../static/js/myOrder.js";

const SONGS = {
  slow: { id: "slow", title: "Anthem", bpm: SLOW_MAX_BPM - 1, createdAt: 1, favorite: true },
  fast: { id: "fast", title: "Zebra", bpm: FAST_MIN_BPM + 1, createdAt: 2, favorite: false },
  mid: { id: "mid", title: "Middle", bpm: SLOW_MAX_BPM + 1, createdAt: 3, favorite: true },
};
const IDS = ["mid", "fast", "slow"];
const songOf = (id) => SONGS[id];
const BY_TITLE = { sort: SORT_KEYS.TITLE, dir: DIRECTIONS.ASC, filters: DEFAULT_FILTERS, myOrderIds: [] };
const FAVORITES_ONLY = { ...BY_TITLE, filters: { ...DEFAULT_FILTERS, favoritesOnly: true } };
const FAST_ONLY = { ...BY_TITLE, filters: { ...DEFAULT_FILTERS, tempo: TEMPO_BANDS.FAST } };

test("All songs, Favorites and a folder sort and filter", () => {
  for (const kind of [VIEW.ALL, VIEW.FAVORITES, VIEW.FOLDER]) {
    assert.deepEqual(arrangeIds(kind, IDS, songOf, BY_TITLE), ["slow", "mid", "fast"], kind);
    assert.deepEqual(arrangeIds(kind, IDS, songOf, FAVORITES_ONLY), ["slow", "mid"], kind);
  }
});

test("Recently added, the Trash, setlists and the queue keep their own order", () => {
  for (const kind of [VIEW.RECENT, VIEW.TRASH, VIEW.SETLIST, VIEW.QUEUE]) {
    assert.equal(isArrangedView(kind), false, kind);
    assert.deepEqual(arrangeIds(kind, IDS, songOf, FAVORITES_ONLY), IDS, kind);
  }
});

test("a song the library no longer has is left out", () => {
  assert.deepEqual(arrangeIds(VIEW.ALL, ["gone", ...IDS], songOf, BY_TITLE), ["slow", "mid", "fast"]);
});

test("My order follows the saved ids", () => {
  const view = { ...BY_TITLE, sort: SORT_KEYS.MY_ORDER, myOrderIds: ["fast", "slow", "mid"] };
  assert.deepEqual(arrangeIds(VIEW.ALL, IDS, songOf, view), ["fast", "slow", "mid"]);
  assert.equal(showsMyOrder(VIEW.ALL, view), true);
  assert.equal(showsMyOrder(VIEW.RECENT, view), false);
  assert.equal(showsMyOrder(VIEW.ALL, BY_TITLE), false);
});

test("library views pick for library actions, the Trash for Restore, others not at all", () => {
  for (const kind of [VIEW.ALL, VIEW.FAVORITES, VIEW.FOLDER, VIEW.RECENT]) {
    assert.equal(selectScopeOf(kind), SELECTION_SCOPES.LIBRARY, kind);
  }
  assert.equal(selectScopeOf(VIEW.TRASH), SELECTION_SCOPES.TRASH);
  assert.equal(selectScopeOf(VIEW.SETLIST), null);
  assert.equal(selectScopeOf(VIEW.QUEUE), null);
});

test("the filters hid everything only when they are on and the view had songs", () => {
  assert.equal(filtersHideAll(VIEW.ALL, FAST_ONLY, 0, 3), true);
  assert.equal(filtersHideAll(VIEW.ALL, FAST_ONLY, 1, 3), false);
  assert.equal(filtersHideAll(VIEW.ALL, FAST_ONLY, 0, 0), false);
  assert.equal(filtersHideAll(VIEW.ALL, BY_TITLE, 0, 3), false);
  assert.equal(filtersHideAll(VIEW.RECENT, FAST_ONLY, 0, 3), false);
});

test("a dragged pick moves every pick in pick order; an unpicked song moves alone", () => {
  assert.deepEqual(movedIdsFor("b", ["c", "b"]), ["c", "b"]);
  assert.deepEqual(movedIdsFor("a", ["c", "b"]), ["a"]);
});

test("dropping picks on a song saves the whole order with them before it, in their saved order", () => {
  const library = IDS.map(songOf);
  const moved = movedIdsFor("slow", ["mid", "slow"]);
  assert.deepEqual(myOrderAfterMove(library, ["fast", "slow", "mid"], moved, "fast"), ["slow", "mid", "fast"]);
});

test("bulk Favorite skips songs already favorites; other actions take every pick", () => {
  const isFavorite = (id) => SONGS[id].favorite;
  assert.deepEqual(bulkTargets(BULK_ACTION.FAVORITE, IDS, isFavorite), ["fast"]);
  for (const action of [BULK_ACTION.TRASH, BULK_ACTION.UP_NEXT, BULK_ACTION.RESTORE]) {
    assert.deepEqual(bulkTargets(action, IDS, isFavorite), IDS, action);
  }
});
