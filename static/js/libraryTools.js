// Browse library's sort, filters, My order and Select, as the overlay and its views use them.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { getLibraryTrack, libraryTrackIds } from "./catalog.js";
import { arrangeIds, filtersHideAll, showsMyOrder } from "./libraryArrange.js";
import {
  clearLibraryFilters, libraryView, loadLibraryViewPrefs, noteLibrarySongs, onLibraryViewChange, selection,
} from "./libraryView.js";
import { initLibraryToolbar, paintLibraryToolbar } from "./libraryToolbar.js";
import { initBulkBar, paintBulkBar } from "./libraryBulkBar.js";
import { paintPicks, visibleIds, wirePicking } from "./libraryPicking.js";

export { decorateSongEl } from "./libraryPicking.js";
export { sortableHeadEl } from "./libraryHeads.js";

let results = null;
let viewKind = () => null;
let redraw = () => {};

/** A view's songs in the order, and through the filters, the library view asks for. */
export function viewSongIds(kind, ids) {
  return arrangeIds(kind, ids, getLibraryTrack, libraryView());
}

export function myOrderHintEls(kind) {
  if (!showsMyOrder(kind, libraryView())) return [];
  const hint = document.createElement("p");
  hint.className = "library-hint";
  hint.textContent = t("libSort.myOrderHint");
  return [hint];
}

/** The empty state for a view the filters emptied, with Clear filters; null otherwise. */
export function filteredOutEl(kind, shownCount, viewCount) {
  if (!filtersHideAll(kind, libraryView(), shownCount, viewCount)) return null;
  const el = document.createElement("div");
  el.className = "browse-empty";
  el.innerHTML = `${icon("sliders")}<strong></strong><span></span>`;
  el.querySelector("strong").textContent = t("libSort.noFilterMatch");
  el.querySelector("span").textContent = t("libSort.noFilterMatchHint");
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "browse-btn library-clear-filters";
  clear.textContent = t("libSort.clearFilters");
  clear.addEventListener("click", clearLibraryFilters);
  el.append(clear);
  return el;
}

/** After a view is drawn: drop picks it no longer shows, and repaint the toolbar and bulk bar. */
export function afterResultsDrawn(container, kind) {
  noteLibrarySongs(libraryTrackIds());
  if (selection.picking) selection.prune(visibleIds(container));
  paintLibraryToolbar(kind);
  paintBulkBar(kind, container);
}

/** Leave Select without a redraw; true when it was picking. */
export function endPicking() {
  const was = selection.picking;
  selection.done();
  return was;
}

/** Esc while picking leaves Select and keeps Browse library open; true when it did. */
export function leaveSelectOnEscape() {
  if (!selection.picking) return false;
  selection.done();
  redraw();
  return true;
}

function onPicksChange() {
  paintPicks(results);
  paintBulkBar(viewKind(), results);
}

function finishPicking() {
  selection.done();
  redraw();
}

function selectAllShown() {
  selection.selectAll(visibleIds(results));
  onPicksChange();
}

function onSelectToggle() {
  if (selection.picking) selection.done();
  else selection.start();
  redraw();
}

export function initLibraryTools(container, { redraw: redrawView, viewKind: kindOf }) {
  results = container;
  redraw = redrawView;
  viewKind = kindOf;
  initLibraryToolbar({ onSelectToggle });
  initBulkBar({ finish: finishPicking, selectAll: selectAllShown });
  wirePicking(container, { viewKind, onPicksChange, onPickingStart: redraw });
  onLibraryViewChange(redraw);
  loadLibraryViewPrefs();
}
