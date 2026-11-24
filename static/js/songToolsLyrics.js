// The song tools' Lyrics button shows the sidebar's Lyrics view and back.

import { CATALOG_VIEW_EVENT, LYRICS_VIEW, isLyricsViewShown, showLibraryView, showLyricsView } from "./catalog.js";

function lyricsButton() {
  return document.getElementById("songToolsLyricsBtn");
}

function paintLyricsButton(on) {
  const btn = lyricsButton();
  btn?.classList.toggle("active", on);
  btn?.setAttribute("aria-pressed", String(on));
}

function onLyricsButtonClick() {
  if (isLyricsViewShown()) showLibraryView();
  else showLyricsView();
}

function onCatalogViewChange(e) {
  paintLyricsButton(e.detail?.view === LYRICS_VIEW);
}

export function initSongToolsLyrics() {
  lyricsButton()?.addEventListener("click", onLyricsButtonClick);
  document.addEventListener(CATALOG_VIEW_EVENT, onCatalogViewChange);
  paintLyricsButton(isLyricsViewShown());
}
