import { focusBrowseSearch } from "./browseLibrary.js";

// main.js opens the pickers from these; this opens Add song around them.
const OPENS_ADD_SONG = ["emptyStartUpload", "emptyStartFolder"];
const BROWSE_ID = "emptyStartBrowse";

function onBrowseLibrary() {
  focusBrowseSearch();
}

/** `openComposer` is injected: composerDrawer.js wires this module and must not be imported back. */
export function wireEmptyStart(openComposer) {
  for (const id of OPENS_ADD_SONG) document.getElementById(id)?.addEventListener("click", openComposer);
  document.getElementById(BROWSE_ID)?.addEventListener("click", onBrowseLibrary);
}
