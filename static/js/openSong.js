// Opening a song versus playing it (#211): a click shows a song over the one playing, or
// loads it paused when none plays; double-click, Enter and the Play buttons open and play.

import {
  dropShownTrack,
  getPlayingTrackInfo,
  isLoadingTrack,
  loadTrackIntoStudio,
  showTrackOverPlayer,
  shownTrackId,
} from "./catalog.js";
import { playWhenLoaded, upNextTakesOver } from "./upNext.js";
import { setPlayRedirect, stopTransport, togglePlayPause, transport } from "./transport.js";
import { $ } from "./utils.js";

// The song whose engine said "playbackready" last, so Play can start it at once.
let readyTrackId = null;

const playingTrackId = () => getPlayingTrackInfo()?.id ?? null;
const isPlaying = () => transport()?.isPlaying() === true;

/** A single click: show the song over the one playing, or load it when none plays. */
export function openSong(trackId) {
  if (trackId === playingTrackId()) {
    dropShownTrack();
    return;
  }
  if (trackId === shownTrackId() || isLoadingTrack(trackId)) return;
  if (isPlaying()) showTrackOverPlayer(trackId);
  else loadTrackIntoStudio(trackId);
}

/** Open the song and play it, through the same load a click with nothing playing uses. */
export function playSong(trackId) {
  if (trackId === playingTrackId() && trackId === readyTrackId) {
    dropShownTrack();
    if (!isPlaying()) togglePlayPause();
    return;
  }
  playWhenLoaded(trackId);
  if (trackId === playingTrackId() || isLoadingTrack(trackId)) return;
  if (isPlaying()) stopTransport();
  loadTrackIntoStudio(trackId);
}

// Play with a song shown over a paused one starts the shown song.
function playShownSongInstead() {
  const shown = shownTrackId();
  if (!shown) return false;
  playSong(shown);
  return true;
}

function onSongHeadPlayClick() {
  const shown = shownTrackId();
  if (shown) playSong(shown);
}

// Up Next goes on as before; with nothing queued, the shown song loads, paused.
function onPlayingSongEnded() {
  const shown = shownTrackId();
  if (shown && !upNextTakesOver()) loadTrackIntoStudio(shown);
}

function onPlaybackReady(e) {
  readyTrackId = e.detail?.id ?? null;
}

export function initOpenSong() {
  setPlayRedirect(playShownSongInstead);
  $("songPlayBtn")?.addEventListener("click", onSongHeadPlayClick);
  document.addEventListener("trackended", onPlayingSongEnded);
  document.addEventListener("playbackready", onPlaybackReady);
}
