// Ctrl+K or ⌘K jumps to the library search, except in Stage mode or behind a modal.

import { isSidebarCollapsed, setSidebarCollapsed, showLibraryView } from "./catalog.js";
import { isStageMode, isModalOpen } from "./stageMode.js";

const SEARCH_SHORTCUT_CODE = "KeyK";

function isSearchShortcut(e) {
  if (e.code !== SEARCH_SHORTCUT_CODE || e.altKey || e.shiftKey) return false;
  return e.ctrlKey !== e.metaKey;
}

function isLyricsViewShown() {
  return Boolean(document.querySelector(".sidebar.lyrics-view"));
}

function onSearchShortcutKeydown(e) {
  if (!isSearchShortcut(e) || isStageMode() || isModalOpen()) return;
  const input = document.getElementById("catalogSearch");
  if (!input) return;
  e.preventDefault();
  if (isSidebarCollapsed()) setSidebarCollapsed(false);
  if (isLyricsViewShown()) showLibraryView();
  input.focus();
  input.select();
}

export function initSearchShortcut() {
  document.addEventListener("keydown", onSearchShortcutKeydown);
}
