// The open song's Up Next and More buttons, in the song head and in Stage.
// More opens the song menu without Rename: the song head renames in place.

import {
  TRACK_SHOW_EVENT,
  TRASH_CHANGE_EVENT,
  getCurrentTrackInfo,
  getPlayingTrackInfo,
  isPlayableTrack,
} from "./catalog.js";
import { queueUpNext } from "./upNext.js";
import { openSongMenu } from "./songMenu.js";
import { closeMenu } from "./floatMenu.js";

// inspectorMore.js opens its More menu through this module.
export { openMenu } from "./floatMenu.js";

const STAGE_UP_NEXT_ID = "stageUpNextBtn";
const STAGE_MORE_ID = "stageMoreBtn";
const OPEN_SONG_UP_NEXT_IDS = ["songUpNextBtn", STAGE_UP_NEXT_ID];
const OPEN_SONG_MORE_IDS = ["songMoreBtn", STAGE_MORE_ID];
// Stage shows the song in the player, which keeps playing while another is shown.
const STAGE_SONG_IDS = new Set([STAGE_UP_NEXT_ID, STAGE_MORE_ID]);

function openSongButtons(ids = [...OPEN_SONG_UP_NEXT_IDS, ...OPEN_SONG_MORE_IDS]) {
  return ids.map((id) => document.getElementById(id)).filter(Boolean);
}

/** The library row's rule: a trashed or unfinished open song is offered to nothing. */
function playableOpenSongId(button) {
  const info = STAGE_SONG_IDS.has(button.id) ? getPlayingTrackInfo() : getCurrentTrackInfo();
  return isPlayableTrack(info?.id) ? info.id : null;
}

function paintOpenSongButtons() {
  for (const button of openSongButtons()) button.disabled = !playableOpenSongId(button);
}

function onAddOpenSongToUpNext(e) {
  const id = playableOpenSongId(e.currentTarget);
  if (id) queueUpNext(id);
}

function onOpenSongMenuClick(e) {
  const id = playableOpenSongId(e.currentTarget);
  if (!id) {
    closeMenu();
    return;
  }
  openSongMenu(id, { anchor: e.currentTarget, rename: false });
}

export function initTrackMenu() {
  for (const button of openSongButtons(OPEN_SONG_UP_NEXT_IDS)) {
    button.addEventListener("click", onAddOpenSongToUpNext);
  }
  for (const button of openSongButtons(OPEN_SONG_MORE_IDS)) {
    button.addEventListener("click", onOpenSongMenuClick);
  }
  for (const eventName of ["trackopen", TRACK_SHOW_EVENT, "tracknames", TRASH_CHANGE_EVENT]) {
    document.addEventListener(eventName, paintOpenSongButtons);
  }
  paintOpenSongButtons();
}
