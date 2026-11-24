// One keyboard and mouse model for every list of library songs: a click shows a
// song, a double-click or Enter plays it, Delete trashes a row reached by keyboard.

import { getLibraryTrack, isTextEditingTarget } from "./catalog.js";
import { trashWithUndo } from "./trashUndo.js";
import { openSong, playSong, playVersion } from "./openSong.js";
import { ON_ROW, isShown, wireRovingRows } from "./rovingRows.js";
import { isDialogOpen } from "./shellEscape.js";

export const SONG_ROW_SELECTOR = ".cat-item:not(.in-trash):not(.queue-row)";
const TRASH_ROW_SELECTOR = ".cat-item.in-trash";
const VERSION_ROW_SELECTOR = ".cat-version:not(.queue-running):not(.renaming-row)";
const DELETE_KEYS = new Set(["Delete", "Backspace"]);
// A setlist's song leaves the setlist with its own button; Delete never bins it.
const DELETABLE_ROW_SELECTOR = `${SONG_ROW_SELECTOR}:not(.setlist-song)`;
const ROW_ACTIONS = [
  `${SONG_ROW_SELECTOR} .cat-actions button`,
  `${SONG_ROW_SELECTOR} :is(.song-card-fav, .song-card-more)`,
  `${TRASH_ROW_SELECTOR} .cat-actions button`,
  `${SONG_ROW_SELECTOR} .import-fail-panel :is(button, a)`,
  ".cat-version .cat-actions button",
  ".cat-item .cat-versions-toggle",
].join(", ");
const lists = new Map();
// Topmost first: Browse library covers the sidebar while it is open.
const SONG_LIST_IDS = ["browseResults", "catalogList"];
export const IN_SONG_LISTS = ":is(#browseResults, #catalogList)";

/** The first match of `selector` in the topmost song list that shows one, or null. */
export function shownInSongLists(selector) {
  for (const id of SONG_LIST_IDS) {
    const el = document.getElementById(id)?.querySelector(selector);
    if (el && isShown(el)) return el;
  }
  return null;
}

function songRowKey(row) {
  return row.dataset.version ? `${row.dataset.id}:${row.dataset.version}` : row.dataset.id;
}

function preferredSongRow(rows) {
  return rows.find((row) => row.matches(`${SONG_ROW_SELECTOR}.active`)) ?? rows.find((row) => row.matches(SONG_ROW_SELECTOR));
}

// A click shows a song over the player; a version row keeps to being selected and a Trash row opens nothing.
function showSongRow(row) {
  if (!row.dataset.version && !row.matches(TRASH_ROW_SELECTOR)) openSong(row.dataset.id);
}

function playSongRow(row) {
  if (row.matches(TRASH_ROW_SELECTOR)) return false;
  if (row.dataset.version) playVersion(row.dataset.id, row.dataset.version);
  else playSong(row.dataset.id);
  return true;
}

/** Wire a list of song rows; `afterPlay()` runs once a row was played from it. */
export function wireSongList(container, { afterPlay = null } = {}) {
  const rows = wireRovingRows(
    container,
    {
      rowSelector: `${SONG_ROW_SELECTOR}, ${VERSION_ROW_SELECTOR}, ${TRASH_ROW_SELECTOR}`,
      actionSelector: ROW_ACTIONS,
      keyOf: songRowKey,
      openRow: function openSongRow(row) {
        if (playSongRow(row)) afterPlay?.();
      },
      showRow: showSongRow,
      preferredRow: preferredSongRow,
      selectableRow: `${SONG_ROW_SELECTOR}, ${VERSION_ROW_SELECTOR}`,
    },
  );
  lists.set(container, rows);
  return rows;
}

const rowIn = (container, trackId) => container.querySelector(`.cat-item[data-id="${CSS.escape(trackId)}"]`);

/** Focus a song's row, or one of its controls, in the topmost list that shows it; false when none does. */
export function focusSongRow(trackId, controlSelector = null) {
  for (const [container, rows] of [...lists].reverse()) {
    const row = rowIn(container, trackId);
    if (!row || !isShown(row)) continue;
    rows.focusRow(row, ON_ROW, { preventScroll: true, focusVisible: false });
    if (controlSelector) row.querySelector(controlSelector)?.focus();
    return true;
  }
  return false;
}

function keyboardFocusedSong(target) {
  for (const [container, rows] of lists) {
    const row = target?.closest?.(DELETABLE_ROW_SELECTOR);
    if (row && container.contains(row) && rows.isKeyboardFocus() && getLibraryTrack(row.dataset.id)) return row.dataset.id;
  }
  return null;
}

// Only a row holding the keyboard's focus: Delete in a dialog or on a clicked row trashes nothing.
function onLibraryDeleteKey(e) {
  if (!DELETE_KEYS.has(e.key) || isTextEditingTarget(e.target) || isDialogOpen()) return;
  const trackId = keyboardFocusedSong(e.target);
  if (!trackId) return;
  e.preventDefault();
  trashWithUndo(trackId);
}

export function initLibraryRows() {
  document.addEventListener("keydown", onLibraryDeleteKey);
}
