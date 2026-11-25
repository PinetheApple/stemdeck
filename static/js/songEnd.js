// Starts what a song's end leads to; the order lives in songEndStep.

import { repeatMode } from "./footerRepeat.js";
import { hasPlayableList, nextInContext, playListAgain } from "./playContext.js";
import { SONG_END_STEP, songEndStep } from "./repeatModel.js";
import { restartSong, togglePlayPause, transport } from "./transport.js";
import {
  firstInUpNext,
  handOffTo,
  isPlayPending,
  playNextInUpNext,
  playNow,
  playedFromUpNext,
  replayUpNextRun,
} from "./upNext.js";

function playSongAgain() {
  restartSong();
  if (!transport()?.isPlaying()) togglePlayPause();
}

function playUpNextAtEnd() {
  handOffTo(firstInUpNext(), playNextInUpNext);
}

function playListAtEnd() {
  const next = nextInContext();
  handOffTo(next, function playListNext() {
    playNow(next);
  });
}

const STEPS = Object.freeze({
  [SONG_END_STEP.SONG_AGAIN]: playSongAgain,
  [SONG_END_STEP.UP_NEXT]: playUpNextAtEnd,
  [SONG_END_STEP.LIST_NEXT]: playListAtEnd,
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
