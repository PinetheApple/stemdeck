// Which song the player is playing, from the player's play-state event, so
// library rows can show moving bars while it plays and Resume when paused.

import { PLAYSTATE_EVENT } from "./player.js";

let state = { id: null, playing: false };
const listeners = new Set();

export function isSongPlaying(trackId) {
  return state.playing && state.id === trackId;
}

export function onPlayStateChange(listener) {
  listeners.add(listener);
}

function onPlayState(e) {
  const next = { id: e.detail?.id ?? null, playing: Boolean(e.detail?.playing) };
  if (next.id === state.id && next.playing === state.playing) return;
  state = next;
  for (const listener of listeners) listener(state);
}

export function initPlayState() {
  document.addEventListener(PLAYSTATE_EVENT, onPlayState);
}
