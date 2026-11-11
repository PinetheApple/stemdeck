// Media keys, headset buttons and the OS media controls, through
// navigator.mediaSession: they drive the transport, and the OS is told which
// song is open, whether it plays, and where the playhead is.

import { getCurrentTrackInfo, getLibraryTrack, displayTitle, libraryTitle } from "./catalog.js";
import { togglePlayPause, stopTransport, setPlayheadTime, transport } from "./transport.js";
import { playNextInUpNext } from "./upNext.js";
import { totalDuration, playbackSpeed } from "./state.js";
import { metadataInit, positionStateFor, positionDrifted } from "./mediaSessionModel.js";

const ACTION = Object.freeze({
  PLAY: "play",
  PAUSE: "pause",
  STOP: "stop",
  NEXT_TRACK: "nexttrack",
  SEEK_TO: "seekto",
  SEEK_BACKWARD: "seekbackward",
  SEEK_FORWARD: "seekforward",
});
const PLAYBACK = Object.freeze({ PLAYING: "playing", PAUSED: "paused", NONE: "none" });
// The same step as the [ and ] keys.
const SEEK_STEP_SEC = 5;
const PLAY_BUTTON_ID = "t-play";
const AUDIO_SESSION_PLAYBACK = "playback";

const session = globalThis.navigator?.mediaSession ?? null;
let openTrackId = null;
let reported = null;

const isPlaying = () => transport()?.isPlaying() === true;
const currentPosition = () => transport()?.getCurrentTime() ?? 0;

function setActionHandler(action, handler) {
  try {
    session.setActionHandler(action, handler);
  } catch (error) {
    // Browsers throw for actions they do not offer; the others still work.
    console.debug(`[mediaSession] ${action} is not offered here:`, error);
  }
}

function clearPosition() {
  if (!reported) return;
  session.setPositionState();
  reported = null;
}

function reportPosition() {
  if (!openTrackId) return;
  const state = positionStateFor({
    duration: totalDuration,
    position: currentPosition(),
    rate: playbackSpeed,
  });
  if (!state) {
    clearPosition();
    return;
  }
  const playing = isPlaying();
  const now = performance.now();
  if (!positionDrifted(reported, state, playing, now)) return;
  session.setPositionState(state);
  reported = { state, playing, atMs: now };
}

function syncPlayback() {
  if (!openTrackId) return;
  session.playbackState = isPlaying() ? PLAYBACK.PLAYING : PLAYBACK.PAUSED;
  reportPosition();
}

function openSongMetadata() {
  const track = getLibraryTrack(openTrackId);
  const info = getCurrentTrackInfo();
  const named = info?.id === openTrackId ? info : null;
  return metadataInit({
    title: named?.displayTitle || (track ? displayTitle(libraryTitle(track)) : ""),
    artist: named?.artist,
    album: named?.audioTags?.album,
    artwork: track?.thumb,
  });
}

function syncMetadata() {
  if (!openTrackId) return;
  const init = openSongMetadata();
  session.metadata = init ? new MediaMetadata(init) : null;
}

function seekTo(sec) {
  if (!Number.isFinite(sec)) return;
  setPlayheadTime(sec);
  reportPosition();
}

function playFromMediaKey() {
  if (!isPlaying()) togglePlayPause();
}

function pauseFromMediaKey() {
  if (isPlaying()) togglePlayPause();
}

function seekFromMediaControls(details) {
  seekTo(details.seekTime);
}

function seekBackFromMediaKey(details) {
  seekTo(currentPosition() - (details.seekOffset ?? SEEK_STEP_SEC));
}

function seekAheadFromMediaKey(details) {
  seekTo(currentPosition() + (details.seekOffset ?? SEEK_STEP_SEC));
}

function onTrackOpen(e) {
  openTrackId = e.detail?.id ?? null;
  reported = null;
  syncMetadata();
  syncPlayback();
}

function onUpNextChange(e) {
  setActionHandler(
    ACTION.NEXT_TRACK,
    e.detail?.count ? playNextInUpNext : null,
  );
}

function watchPlayButton() {
  const button = document.getElementById(PLAY_BUTTON_ID);
  if (!button) return;
  // The engine emits no play or pause events; this button's state is the one place both show.
  new MutationObserver(syncPlayback).observe(
    button,
    { attributes: true, attributeFilter: ["class"] },
  );
}

/** Each transport tick: report the position again only when the OS would have it wrong. */
export function noteMediaPosition() {
  if (session) reportPosition();
}

/** No song is open: the OS controls show nothing and say nothing plays. */
export function clearMediaSession() {
  if (!session) return;
  openTrackId = null;
  session.metadata = null;
  session.playbackState = PLAYBACK.NONE;
  clearPosition();
}

export function initMediaSession() {
  if (!session) return;
  if (navigator.audioSession) navigator.audioSession.type = AUDIO_SESSION_PLAYBACK;
  setActionHandler(ACTION.PLAY, playFromMediaKey);
  setActionHandler(ACTION.PAUSE, pauseFromMediaKey);
  setActionHandler(ACTION.STOP, stopTransport);
  setActionHandler(ACTION.SEEK_TO, seekFromMediaControls);
  setActionHandler(ACTION.SEEK_BACKWARD, seekBackFromMediaKey);
  setActionHandler(ACTION.SEEK_FORWARD, seekAheadFromMediaKey);
  setActionHandler(ACTION.NEXT_TRACK, null);
  document.addEventListener("trackopen", onTrackOpen);
  document.addEventListener("tracknames", syncMetadata);
  document.addEventListener("tracktags", syncMetadata);
  document.addEventListener("upnext:change", onUpNextChange);
  watchPlayButton();
}
