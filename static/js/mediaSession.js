import { getCurrentTrackInfo, getLibraryTrack, displayTitle, libraryTitle } from "./catalog.js";
import { togglePlayPause, stopTransport, setPlayheadTime, transport } from "./transport.js";
import { playNextInUpNext } from "./upNext.js";
import { totalDuration, playbackSpeed, playBtn, loopEnabled, loopStart } from "./state.js";
import { SEEK_STEP_SEC } from "./constants.js";
import {
  metadataInit,
  positionStateFor,
  positionDrifted,
  nextMotion,
  STILL,
} from "./mediaSessionModel.js";

const ACTION = Object.freeze({
  PLAY: "play",
  PAUSE: "pause",
  STOP: "stop",
  NEXT_TRACK: "nexttrack",
  PREVIOUS_TRACK: "previoustrack",
  SEEK_TO: "seekto",
  SEEK_BACKWARD: "seekbackward",
  SEEK_FORWARD: "seekforward",
});
const PLAYBACK = Object.freeze({ PLAYING: "playing", PAUSED: "paused", NONE: "none" });
const SONG_START_SEC = 0;
const AUDIO_SESSION_PLAYBACK = "playback";

const session = globalThis.navigator?.mediaSession ?? null;
let openTrackId = null;
let reported = null;
let motion = STILL;

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

function reportPosition(moving) {
  const state = positionStateFor({
    duration: totalDuration,
    position: currentPosition(),
    rate: playbackSpeed,
  });
  if (!state) {
    clearPosition();
    return;
  }
  const now = performance.now();
  if (!positionDrifted(reported, state, moving, now)) return;
  session.setPositionState(state);
  reported = { state, playing: moving, atMs: now };
}

// Playing only once the playhead moves, so a count-in reads as paused at its start.
function syncPlayback() {
  if (!openTrackId) return;
  motion = nextMotion(motion, isPlaying(), currentPosition());
  const state = motion.moving ? PLAYBACK.PLAYING : PLAYBACK.PAUSED;
  if (session.playbackState !== state) session.playbackState = state;
  reportPosition(motion.moving);
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
  syncPlayback();
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

// Up Next keeps no played history, so previous restarts the open song, as Stop does.
function restartFromMediaKey() {
  seekTo(loopEnabled ? loopStart : SONG_START_SEC);
}

function onTrackOpen(e) {
  openTrackId = e.detail?.id ?? null;
  reported = null;
  motion = STILL;
  setActionHandler(
    ACTION.PREVIOUS_TRACK,
    openTrackId ? restartFromMediaKey : null,
  );
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
  if (!playBtn) return;
  // The engine emits no play or pause events; this button's state is the one place both show.
  new MutationObserver(syncPlayback).observe(
    playBtn,
    { attributes: true, attributeFilter: ["class"] },
  );
}

/** Each transport tick: report the position again only when the OS would have it wrong. */
export function noteMediaPosition() {
  if (session) syncPlayback();
}

/** No song is open: the OS controls show nothing and say nothing plays. */
export function clearMediaSession() {
  if (!session) return;
  openTrackId = null;
  session.metadata = null;
  session.playbackState = PLAYBACK.NONE;
  motion = STILL;
  setActionHandler(ACTION.PREVIOUS_TRACK, null);
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
