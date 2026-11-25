// What starts when the playing song ends: Repeat song, then Up Next, then the list it was
// played from, then Repeat queue's way back to the first song.

import { repeatMode } from "./footerRepeat.js";
import { hasPlayableList, nextInContext, playListAgain } from "./playContext.js";
import { SONG_END_STEP, songEndStep } from "./repeatModel.js";
import { restartSong, togglePlayPause, transport } from "./transport.js";
import {
  firstInUpNext,
  isPlayPending,
  playNow,
  playUpNextAtSongEnd,
  playedFromUpNext,
  replayUpNextRun,
} from "./upNext.js";

function playSongAgain() {
  restartSong();
  if (!transport()?.isPlaying()) togglePlayPause();
}

function playNextInList() {
  playNow(nextInContext());
}

const STEPS = Object.freeze({
  [SONG_END_STEP.SONG_AGAIN]: playSongAgain,
  [SONG_END_STEP.UP_NEXT]: playUpNextAtSongEnd,
  [SONG_END_STEP.LIST_NEXT]: playNextInList,
  [SONG_END_STEP.UP_NEXT_AGAIN]: replayUpNextRun,
  [SONG_END_STEP.LIST_AGAIN]: playListAgain,
});

function currentStep() {
  return songEndStep({
    mode: repeatMode(),
    queued: Boolean(firstInUpNext()),
    listAhead: Boolean(nextInContext()),
    upNextPlayed: playedFromUpNext(),
    listPlayable: hasPlayableList(),
  });
}

function onSongEnded() {
  STEPS[currentStep()]?.();
}

/** Whether the song that just ended hands the studio to another song, or plays again. */
export function songEndTakesOver() {
  return isPlayPending() || currentStep() !== null;
}

export function initSongEnd() {
  document.addEventListener("trackended", onSongEnded);
}
