// A click shows a song over the one playing, or loads it paused when none plays;
// double-click, Enter and the Play buttons open and play.

import {
  dropShownTrack,
  getPlayingTrackInfo,
  isLoadingTrack,
  loadTrackIntoStudio,
  showTrackOverPlayer,
  shownTrackId,
} from "./catalog.js";
import { setPlayingTitle } from "./openPreview.js";
import { openVersion } from "./versions.js";
import { cancelPlayWhenLoaded, loadAndPlay, playWhenLoaded, upNextTakesOver } from "./upNext.js";
import { setPlayRedirect, togglePlayPause, transport } from "./transport.js";
import { $ } from "./utils.js";

// The song whose engine said "playbackready" last, so Play can start it at once.
let readyTrackId = null;

const playingTrackId = () => getPlayingTrackInfo()?.id ?? null;
const isPlaying = () => transport()?.isPlaying() === true;

/** A single click: show the song over the one playing, or load it when none plays. */
export function openSong(trackId) {
  cancelPlayWhenLoaded();
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
  if (trackId === playingTrackId() || isLoadingTrack(trackId)) {
    playWhenLoaded(trackId);
    return;
  }
  loadAndPlay(trackId);
}

/** Double-click or Play on a version row: open that version and play it. */
export async function playVersion(trackId, versionId) {
  playWhenLoaded(trackId);
  if (await openVersion(trackId, versionId)) return;
  cancelPlayWhenLoaded();
  if (trackId !== playingTrackId()) return;
  dropShownTrack();
  if (!isPlaying()) togglePlayPause();
}

function playShownSongInstead() {
  const shown = shownTrackId();
  if (!shown || isPlaying()) return false;
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

function onTrackNames() {
  if (shownTrackId()) setPlayingTitle(getPlayingTrackInfo()?.displayTitle ?? "");
}

export function initOpenSong() {
  setPlayRedirect(playShownSongInstead);
  $("songPlayBtn")?.addEventListener("click", onSongHeadPlayClick);
  document.addEventListener("trackended", onPlayingSongEnded);
  document.addEventListener("playbackready", onPlaybackReady);
  document.addEventListener("tracknames", onTrackNames);
}
