// Previous and Next, Back and Forward in the song header, and the list Next goes on through.

import { initPlayContext } from "./playContext.js";
import { initPlayHistory } from "./playHistory.js";
import { initShownHistory } from "./shownHistory.js";
import { initUpNextFrom } from "./upNextFrom.js";

export function initSongSteps() {
  initPlayContext();
  initPlayHistory();
  initShownHistory();
  initUpNextFrom();
}
