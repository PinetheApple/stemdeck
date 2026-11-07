// The states a lyrics run on the server reports, from GET .../lyrics/retime
// and GET .../lyrics/transcribe.

export const RUN_STATE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  UNSURE: "unsure",
  NO_SINGING: "no_singing",
  HAS_LYRICS: "has_lyrics",
});
