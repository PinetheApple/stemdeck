// The library's sort, filters and saved My order, shared by Browse library's views and
// toolbar, and the songs picked in Select.

import { loadLibraryView, saveLibraryView } from "./libraryPrefs.js";
import { DEFAULT_SORT } from "./librarySort.js";
import { clearFilters } from "./libraryFilter.js";
import { loadMyOrder, saveMyOrder } from "./myOrder.js";
import { createSelection } from "./librarySelection.js";

const view = { ...DEFAULT_SORT, filters: clearFilters(), myOrderIds: [] };
const listeners = new Set();
let knownSongIds = null;

export const selection = createSelection();
export const libraryView = () => view;

export function onLibraryViewChange(listener) {
  listeners.add(listener);
}

function notify() {
  for (const listener of listeners) listener();
}

function saveAndNotify() {
  saveLibraryView(view);
  notify();
}

export function setSort({ sort, dir }) {
  Object.assign(view, { sort, dir });
  saveAndNotify();
}

export function setFilters(filters) {
  view.filters = filters;
  saveAndNotify();
}

export function clearLibraryFilters() {
  setFilters(clearFilters());
}

export async function loadLibraryViewPrefs() {
  Object.assign(view, await loadLibraryView());
  notify();
}

async function refreshMyOrder() {
  try {
    view.myOrderIds = (await loadMyOrder()) ?? [];
  } catch {
    view.myOrderIds = [];
  }
  notify();
}

/** Ask the server for My order the first time, and again once the library gains songs. */
export function noteLibrarySongs(songIds) {
  const grew = knownSongIds !== null && songIds.some((id) => !knownSongIds.has(id));
  const first = knownSongIds === null;
  knownSongIds = new Set(songIds);
  if (first || grew) refreshMyOrder();
}

/** Show `ids` as My order now and save it; the order before comes back when the save fails. */
export async function saveNewMyOrder(ids) {
  const before = view.myOrderIds;
  view.myOrderIds = ids;
  notify();
  try {
    await saveMyOrder(ids);
    return true;
  } catch {
    if (view.myOrderIds === ids) view.myOrderIds = before;
    notify();
    return false;
  }
}
