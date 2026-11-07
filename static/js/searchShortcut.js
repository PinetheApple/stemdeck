// Ctrl+K or ⌘K jumps to the library search from anywhere outside Stage mode.

import { isSidebarCollapsed, setSidebarCollapsed } from "./catalog.js";
import { isStageMode } from "./stageMode.js";

const SEARCH_SHORTCUT_CODE = "KeyK";

function isSearchShortcut(e) {
  if (e.code !== SEARCH_SHORTCUT_CODE || e.altKey || e.shiftKey) return false;
  return e.ctrlKey !== e.metaKey;
}

function onSearchShortcutKeydown(e) {
  if (!isSearchShortcut(e) || isStageMode()) return;
  const input = document.getElementById("catalogSearch");
  if (!input) return;
  e.preventDefault();
  if (isSidebarCollapsed()) setSidebarCollapsed(false);
  input.focus();
  input.select();
}

export function initSearchShortcut() {
  document.addEventListener("keydown", onSearchShortcutKeydown);
}
