// Browse library: every song, folder, setlist, favorite and the Trash, over the
// player with the page dimmed.

import { onLanguageChange } from "./i18n.js";
import { onLibraryDraw } from "./catalog.js";
import { onQueueChange, queueCount, getQueueSnapshot } from "./queue.js";
import { importQueueShown } from "./importQueueView.js";
import { ESCAPE_KEY, LAYER, escapeIsFor } from "./shellEscape.js";
import { storeGet, storeSet, $ } from "./utils.js";
import { wireSongList } from "./libraryRows.js";
import { onSetlistsChange, setSetlistOpeners } from "./setlists.js";
import { onPlayStateChange } from "./playState.js";
import { NAV_COUNT_CLASS, drawBrowseNav, paintCurrentView, wireBrowseNav } from "./browseNav.js";
import { drawBrowseResults } from "./browseViews.js";
import { drawTagChips, wireBrowseSearch } from "./browseSearch.js";
import { openSetlistRename } from "./setlistRenameDialog.js";
import { LAYOUT, VIEW } from "./browseViewNames.js";
import { afterResultsDrawn, endPicking, initLibraryTools, leaveSelectOnEscape } from "./libraryTools.js";

const LAYOUT_KEY = "stemdeck.browse.layout";
const OPEN_CLASS = "browse-open";

const state = { view: VIEW.ALL, query: "", layout: LAYOUT.GRID };
let opener = null;
let resultRows = null;

export const browseState = () => state;
export const isBrowseOpen = () => !$("browseLibrary")?.hidden;

/** The view's kind and id: "folder:f-1" is ["folder", "f-1"]. */
export function viewParts(view = state.view) {
  const at = view.indexOf(":");
  return at < 0 ? [view, ""] : [view.slice(0, at), view.slice(at + 1)];
}

export function closeBrowse() {
  const overlay = $("browseLibrary");
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  endPicking();
  $("browseScrim").hidden = true;
  document.body.classList.remove(OPEN_CLASS);
  const back = opener?.isConnected ? opener : $("browseBtn");
  opener = null;
  back?.focus();
}

/** Redraw the open overlay: its nav, tag chips and the current view. */
export function renderBrowse() {
  if (!isBrowseOpen()) return;
  drawBrowseNav();
  drawTagChips();
  renderResults();
}

/** Redraw the current view alone, keeping the row that has focus. */
export function renderResults() {
  if (!isBrowseOpen()) return;
  const saved = resultRows?.remember();
  const drawn = drawBrowseResults($("browseResults"));
  if (drawn !== state.view) {
    state.view = drawn;
    drawBrowseNav();
  }
  afterResultsDrawn($("browseResults"), currentViewKind());
  resultRows?.restore(saved);
}

/** Show `view` in the overlay, opening it first when it is closed. */
export function openBrowse(view = state.view) {
  const overlay = $("browseLibrary");
  if (!overlay) return;
  const opening = overlay.hidden;
  if (opening) {
    opener = document.activeElement;
    overlay.hidden = false;
    $("browseScrim").hidden = false;
    document.body.classList.add(OPEN_CLASS);
  }
  if (view !== state.view) endPicking();
  state.view = view;
  // A nav row's own click must not rebuild the nav: its double-click renames the folder.
  if (opening) renderBrowse();
  else {
    paintCurrentView();
    renderResults();
  }
  if (opening) $("browseSearch")?.focus();
}

export function setBrowseQuery(query) {
  state.query = query;
  const input = $("browseSearch");
  if (input && input.value !== query) input.value = query;
  drawTagChips();
  renderResults();
}

/** All songs as a list, the search cleared: every song's row, for the editors that open in one.
 *  The list layout holds for this visit only. */
export function revealSongRows() {
  state.layout = LAYOUT.LIST;
  paintLayoutButtons();
  state.query = "";
  const input = $("browseSearch");
  if (input) input.value = "";
  openBrowse(VIEW.ALL);
}

/** Ctrl/Cmd+K: open the overlay if it is closed, then focus and select its search. */
export function focusBrowseSearch() {
  if (!isBrowseOpen()) openBrowse();
  const input = $("browseSearch");
  input?.focus();
  input?.select();
}

function paintLayoutButtons() {
  for (const [id, layout] of [["browseGridBtn", LAYOUT.GRID], ["browseListBtn", LAYOUT.LIST]]) {
    const on = state.layout === layout;
    $(id)?.setAttribute("aria-pressed", String(on));
    $(id)?.classList.toggle("is-on", on);
  }
}

function setLayout(layout) {
  state.layout = layout;
  paintLayoutButtons();
  storeSet(LAYOUT_KEY, layout);
  renderResults();
}

function currentViewKind() {
  return viewParts()[0];
}

function onGridClick() {
  setLayout(LAYOUT.GRID);
}

function onListClick() {
  setLayout(LAYOUT.LIST);
}

function onBrowseKeydown(e) {
  if (e.key === ESCAPE_KEY && escapeIsFor(LAYER.BROWSE) && !leaveSelectOnEscape()) closeBrowse();
}

const queueNavEntry = () => $("browseNav")?.querySelector(`[data-view="${VIEW.QUEUE}"]`);
const queueNavCount = (entry) => Number(entry.querySelector(`.${NAV_COUNT_CLASS}`)?.textContent ?? 0);

// The nav's Import queue entry comes and goes with the queue, and the view leaves with it.
function onQueueFrame(snap = getQueueSnapshot()) {
  if (!isBrowseOpen()) return;
  const queueShown = importQueueShown(snap);
  const entry = queueNavEntry();
  if (queueShown === Boolean(entry)) {
    if (entry && queueNavCount(entry) !== queueCount(snap)) drawBrowseNav();
    return;
  }
  if (!queueShown && state.view === VIEW.QUEUE) state.view = VIEW.ALL;
  renderBrowse();
}

function showSetlist(id) {
  openBrowse(`${VIEW.SETLIST}:${id}`);
}

async function loadLayout() {
  const stored = await storeGet(LAYOUT_KEY, LAYOUT.GRID);
  state.layout = Object.values(LAYOUT).includes(stored) ? stored : LAYOUT.GRID;
  paintLayoutButtons();
  renderResults();
}

export function initBrowseLibrary() {
  const results = $("browseResults");
  if (!results) return;
  resultRows = wireSongList(results, { afterPlay: closeBrowse });
  initLibraryTools(results, { redraw: renderResults, viewKind: currentViewKind });
  $("browseScrim")?.addEventListener("click", closeBrowse);
  $("browseCloseBtn")?.addEventListener("click", closeBrowse);
  $("browseGridBtn")?.addEventListener("click", onGridClick);
  $("browseListBtn")?.addEventListener("click", onListClick);
  document.addEventListener("keydown", onBrowseKeydown);
  wireBrowseNav();
  wireBrowseSearch();
  setSetlistOpeners({ show: showSetlist, rename: openSetlistRename });
  onLibraryDraw(renderBrowse);
  onSetlistsChange(renderBrowse);
  onPlayStateChange(renderResults);
  onQueueChange(onQueueFrame);
  onLanguageChange(renderBrowse);
  loadLayout();
}

