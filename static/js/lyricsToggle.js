// The song tools' Lyrics button shows the sidebar's Lyrics view and back.

import { isLyricsViewShown, showLibraryView, showLyricsView } from "./catalog.js";

const LYRICS_VIEW = "lyrics";

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

export function initLyricsToggle() {
  lyricsButton()?.addEventListener("click", onLyricsButtonClick);
  document.addEventListener("catalogviewchange", onCatalogViewChange);
  paintLyricsButton(isLyricsViewShown());
}
