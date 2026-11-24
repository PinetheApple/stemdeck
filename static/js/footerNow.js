// The footer's left: the playing song's cover and title. While another song is
// shown in the studio it reads "Playing", and clicking it returns to that song.

import { TRACK_SHOW_EVENT, getLibraryTrack, getPlayingTrackInfo } from "./catalog.js";
import { initSectionLine } from "./footerSections.js";
import { onLanguageChange, t } from "./i18n.js";
import { $ } from "./utils.js";

function paintCover(src) {
  const img = $("footerNowThumb");
  img.hidden = !src;
  if (src) img.src = src;
  else img.removeAttribute("src");
}

function onCoverError(e) {
  e.currentTarget.hidden = true;
}

export function paintPlayingSong() {
  const info = getPlayingTrackInfo();
  $("footerNowTitle").textContent = info ? info.displayTitle : t("studio.footer.nothingOpen");
  $("footerPlayingTitle").disabled = !info;
  paintCover(info ? getLibraryTrack(info.id)?.thumb : "");
}

export function initFooterNow() {
  if (!$("footerPlayingTitle")) return;
  $("footerNowThumb").addEventListener("error", onCoverError);
  // Read here, not at import: catalog.js is still evaluating when this module loads.
  for (const name of ["trackopen", "tracknames", "playbackready", TRACK_SHOW_EVENT]) {
    document.addEventListener(name, paintPlayingSong);
  }
  onLanguageChange(paintPlayingSong);
  paintPlayingSong();
  initSectionLine();
}
