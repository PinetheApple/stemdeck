import { currentJobId, playBtn } from "./state.js";

const PLAYING_CLASS = "playing";
const listeners = new Set();
let playing = false;

// The engines send no play event; the play button's state is the one place both show a start.
function onPlayButtonChange() {
  const now = playBtn.classList.contains(PLAYING_CLASS);
  if (now && !playing && currentJobId) for (const listener of listeners) listener(currentJobId);
  playing = now;
}

/** `listener(trackId)` runs each time the song in the player starts playing. */
export function onSongPlayed(listener) {
  listeners.add(listener);
}

export function initSongPlayed() {
  if (!playBtn) return;
  new MutationObserver(onPlayButtonChange).observe(playBtn, { attributes: true, attributeFilter: ["class"] });
}
