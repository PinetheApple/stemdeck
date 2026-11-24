// Ctrl+K or ⌘K opens Browse library and focuses its search, except in Stage mode or behind a dialog.

import { isStageMode } from "./stageMode.js";
import { isDialogOpen } from "./shellEscape.js";
import { focusBrowseSearch } from "./browseLibrary.js";

const SEARCH_SHORTCUT_CODE = "KeyK";

function isSearchShortcut(e) {
  if (e.code !== SEARCH_SHORTCUT_CODE || e.altKey || e.shiftKey) return false;
  return e.ctrlKey !== e.metaKey;
}

function onSearchShortcutKeydown(e) {
  if (!isSearchShortcut(e) || isStageMode() || isDialogOpen()) return;
  e.preventDefault();
  focusBrowseSearch();
}

export function initSearchShortcut() {
  document.addEventListener("keydown", onSearchShortcutKeydown);
}
