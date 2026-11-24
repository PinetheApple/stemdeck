// The empty studio's start buttons. main.js gives each its action (file picker,
// folder picker, focus the box); these open Add song around it.

import { isSidebarCollapsed, setSidebarCollapsed, showLibraryView } from "./catalog.js";

const OPENS_ADD_SONG = ["emptyStartUpload", "emptyStartFolder", "emptyStartLink"];
const BROWSE_ID = "emptyStartBrowse";
const LIBRARY_SEARCH_ID = "catalogSearch";

function onBrowseLibrary() {
  if (isSidebarCollapsed()) setSidebarCollapsed(false);
  showLibraryView();
  document.getElementById(LIBRARY_SEARCH_ID)?.focus();
}

/** `openComposer` is injected: composerDrawer.js wires this module and must not be imported back. */
export function wireEmptyStart(openComposer) {
  for (const id of OPENS_ADD_SONG) document.getElementById(id)?.addEventListener("click", openComposer);
  document.getElementById(BROWSE_ID)?.addEventListener("click", onBrowseLibrary);
}
