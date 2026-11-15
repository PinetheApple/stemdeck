// Sing along on a song with no timed lyrics: say so, and offer the Lyrics tab's own
// transcription and the tab itself.

import { t, onLanguageChange } from "./i18n.js";
import { $ } from "./utils.js";

const TRANSCRIBE_START = ".lyrics-transcribe-open";
const TRANSCRIBE_MESSAGE = "lyricsTranscribeMessage";
const LYRICS_RAIL = ".rail-lyrics";
const LYRICS_PANEL = "lyricsPanel";

let leave = () => {};

const transcribeStart = () => document.querySelector(TRANSCRIBE_START);

/** While a transcription runs or has just ended, its own message says more than "no lyrics". */
function paintNoLyricsText() {
  const start = transcribeStart();
  const offered = Boolean(start) && !start.hidden;
  const message = $(TRANSCRIBE_MESSAGE)?.textContent.trim();
  const text = $("singEmptyText");
  if (text) text.textContent = !offered && message ? message : t("sing.noLyrics");
  const button = $("singTranscribeBtn");
  if (button) button.hidden = !offered;
}

export function paintSingNoLyrics(show) {
  const box = $("singEmpty");
  if (!box || box.hidden === !show) return;
  box.hidden = !show;
  if (show) paintNoLyricsText();
}

function onTranscribeClick() {
  transcribeStart()?.click();
}

function onOpenLyricsClick() {
  leave();
  document.querySelector(LYRICS_RAIL)?.click();
}

/** The Lyrics panel builds its toolbar when it first draws, so the panel itself is watched. */
function watchTranscription() {
  const panel = $(LYRICS_PANEL);
  if (!panel) return;
  new MutationObserver(onLyricsPanelMutation).observe(
    panel,
    { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["hidden"] },
  );
}

function onLyricsPanelMutation() {
  if ($("singEmpty")?.hidden === false) paintNoLyricsText();
}

/** `leaveStage()` closes Stage before the Lyrics tab opens. */
export function initSingNoLyrics({ leaveStage }) {
  leave = leaveStage;
  $("singTranscribeBtn")?.addEventListener("click", onTranscribeClick);
  $("singOpenLyricsBtn")?.addEventListener("click", onOpenLyricsClick);
  watchTranscription();
  onLanguageChange(paintNoLyricsText);
}
