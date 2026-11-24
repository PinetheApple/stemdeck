// Which Browse views sort, filter and pick songs, and the order a view shows its songs in.

import { VIEW } from "./browseViewNames.js";
import { SORT_KEYS, sortSongs } from "./librarySort.js";
import { activeFilterCount, filterSongs } from "./libraryFilter.js";
import { SELECTION_SCOPES } from "./librarySelection.js";
import { SONG_FIELDS } from "./songFields.js";

const ARRANGED_VIEWS = new Set([VIEW.ALL, VIEW.FAVORITES, VIEW.FOLDER]);
const SELECT_SCOPES = Object.freeze({
  [VIEW.ALL]: SELECTION_SCOPES.LIBRARY,
  [VIEW.FAVORITES]: SELECTION_SCOPES.LIBRARY,
  [VIEW.FOLDER]: SELECTION_SCOPES.LIBRARY,
  [VIEW.RECENT]: SELECTION_SCOPES.LIBRARY,
  [VIEW.TRASH]: SELECTION_SCOPES.TRASH,
});

const isFavorite = (song) => Boolean(song.favorite);

export const isArrangedView = (kind) => ARRANGED_VIEWS.has(kind);

/** The bulk actions' scope in a view, or null where songs cannot be picked. */
export const selectScopeOf = (kind) => SELECT_SCOPES[kind] ?? null;

/** `ids` filtered and sorted as `view` asks, in the views that sort; other views keep their order. */
export function arrangeIds(kind, ids, songOf, { sort, dir, filters, myOrderIds }) {
  if (!isArrangedView(kind)) return ids;
  const songs = ids.map(songOf).filter(Boolean);
  return sortSongs(filterSongs(songs, filters, isFavorite), { sort, dir }, myOrderIds).map(SONG_FIELDS.id);
}

export function showsMyOrder(kind, { sort }) {
  return isArrangedView(kind) && sort === SORT_KEYS.MY_ORDER;
}

/** Whether the filters, not the view itself, left it with no songs. */
export function filtersHideAll(kind, { filters }, shownCount, viewCount) {
  return isArrangedView(kind) && activeFilterCount(filters) > 0 && shownCount === 0 && viewCount > 0;
}

/** A dragged song that is picked brings the other picks along. */
export function movedIdsFor(draggedId, pickedIds) {
  return pickedIds.includes(draggedId) ? [...pickedIds] : [draggedId];
}
