// The lyric line being sung and the next one, in one line under the section blocks.

import { LYRICS_CHANGE_EVENT, ensureLyricsLoaded, getTimedLyricLines } from "./lyrics.js";
import { currentLineIndex } from "./lyricsLookup.js";
import { getPlayingTrackInfo } from "./catalog.js";
import { LYRIC_LEAD_SEC } from "./stageModel.js";
import { lineText } from "./stageLyricLine.js";
import { onPlayheadMove } from "./studioSignals.js";
import { $ } from "./utils.js";

const TICKER_ID = "lyricTicker";
const NOW_SELECTOR = ".lyric-ticker-now";
const NEXT_SELECTOR = ".lyric-ticker-next";

let trackId = null;
let lastSec = 0;
const shown = { now: null, next: null };

function setLine(ticker, key, selector, text) {
  if (shown[key] === text) return;
  shown[key] = text;
  ticker.querySelector(selector).textContent = text;
}

function loadForPlayingTrack() {
  const id = getPlayingTrackInfo()?.id ?? null;
  if (id === trackId) return;
  trackId = id;
  ensureLyricsLoaded();
}

function paintLyricTicker(sec) {
  lastSec = sec;
  const ticker = $(TICKER_ID);
  if (!ticker) return;
  loadForPlayingTrack();
  const lines = getTimedLyricLines();
  const index = currentLineIndex(lines, sec + LYRIC_LEAD_SEC);
  setLine(ticker, "now", NOW_SELECTOR, lineText(lines[index]));
  setLine(ticker, "next", NEXT_SELECTOR, lineText(lines[index + 1]));
}

function onLyricsChange() {
  paintLyricTicker(lastSec);
}

export function initLyricTicker() {
  onPlayheadMove(paintLyricTicker);
  document.addEventListener(LYRICS_CHANGE_EVENT, onLyricsChange);
  paintLyricTicker(lastSec);
}
