import { initPlayContext } from "./playContext.js";
import { initPlayHistory } from "./playHistory.js";
import { initShownHistory } from "./shownHistory.js";
import { initSongPlayed } from "./songPlayed.js";
import { initUpNextFrom } from "./upNextFrom.js";

export function initSongSteps() {
  initSongPlayed();
  initPlayContext();
  initPlayHistory();
  initShownHistory();
  initUpNextFrom();
}
