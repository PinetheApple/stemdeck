import { currentJobId, playBtn } from "./state.js";

export const PLAYING_CLASS = "playing";
const listeners = new Set();
let playing = false;

// The engines send no play event; the play button's state is the one place both show a start.
function onPlayButtonChange() {
  const now = playBtn.classList.contains(PLAYING_CLASS);
  if (now && !playing && currentJobId) for (const listener of listeners) listener(currentJobId);
  playing = now;
}

/** A resume after a pause counts as a start too. */
export function onSongPlayed(listener) {
  listeners.add(listener);
}

export function initSongPlayed() {
  if (!playBtn) return;
  new MutationObserver(onPlayButtonChange).observe(playBtn, { attributes: true, attributeFilter: ["class"] });
}
