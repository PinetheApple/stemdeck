// "I play": the stems the player plays, left out of what the Film view plays
// and of the video. Vocals stands for both of its halves, as on the server.

const NOT_PICKABLE = new Set(["original", "mix"]);
const VOCALS = "vocals";
const VOCAL_HALVES = ["lead_vocals", "backing_vocals"];

/** The song's lanes the picker offers. */
export function pickableStems(laneNames) {
  return laneNames.filter((name) => !NOT_PICKABLE.has(name));
}

/** The song's lanes to silence for `iPlay`. */
export function silencedLanes(iPlay, laneNames) {
  const played = new Set(iPlay);
  if (played.has(VOCALS)) for (const half of VOCAL_HALVES) played.add(half);
  return laneNames.filter((name) => played.has(name));
}
