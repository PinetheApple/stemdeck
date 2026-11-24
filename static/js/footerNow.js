// The footer's left: the playing song's cover and title. While another song is
// shown in the studio it reads "Playing" and becomes a button back to that song.

import { TRACK_SHOW_EVENT, getLibraryTrack, getPlayingTrackInfo, shownTrackId } from "./catalog.js";
import { initFooterKey } from "./footerKey.js";
import { initSectionLine } from "./footerSections.js";
import { onLanguageChange, t } from "./i18n.js";
import { PLAYBACK_READY_EVENT } from "./player.js";
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

// One set of contents, moved into the button only while it has somewhere to go back to.
function paintNowHolder() {
  const another = Boolean(shownTrackId());
  const [from, to] = another ? [$("footerNow"), $("footerPlayingTitle")] : [$("footerPlayingTitle"), $("footerNow")];
  if (from.childNodes.length) to.append(...from.childNodes);
  from.hidden = true;
  to.hidden = false;
}

function playingKey() {
  const info = getPlayingTrackInfo();
  const track = info ? getLibraryTrack(info.id) : null;
  return track ? { key: track.key, scale: track.scale } : null;
}

export function paintPlayingSong() {
  const info = getPlayingTrackInfo();
  $("footerNowTitle").textContent = info ? info.displayTitle : t("studio.footer.nothingOpen");
  paintCover(info ? getLibraryTrack(info.id)?.thumb : "");
  paintNowHolder();
}

export function initFooterNow() {
  if (!$("footerNow")) return;
  $("footerNowThumb").addEventListener("error", onCoverError);
  // Read here, not at import: catalog.js is still evaluating when this module loads.
  for (const name of ["trackopen", "tracknames", PLAYBACK_READY_EVENT, TRACK_SHOW_EVENT]) {
    document.addEventListener(name, paintPlayingSong);
  }
  onLanguageChange(paintPlayingSong);
  paintPlayingSong();
  initSectionLine();
  initFooterKey(playingKey);
}
