// Sing along on a song without timed lyrics: say why, and offer the Lyrics tab's own
// transcription and the tab itself.

import { INSPECTOR_TABS, openInspectorTab } from "./inspector.js";
import { TRANSCRIBE_CHANGE_EVENT, startTranscription, transcribeStatus } from "./lyricsTranscribe.js";
import { t, onLanguageChange } from "./i18n.js";
import { $ } from "./utils.js";

export const NO_LYRICS = Object.freeze({ NONE: "none", UNTIMED: "untimed" });

let leave = () => {};
let shownKind = null;

/** While a transcription runs or has just ended, its own message says more than "no lyrics". */
function paintNoLyricsText() {
  const untimed = shownKind === NO_LYRICS.UNTIMED;
  const { offered, message } = transcribeStatus();
  const text = $("singEmptyText");
  if (text) text.textContent = untimed ? t("sing.untimed") : !offered && message ? message : t("sing.noLyrics");
  const button = $("singTranscribeBtn");
  if (button) button.hidden = untimed || !offered;
}

/** Shows why there is nothing to sing (a NO_LYRICS kind), or hides it for null. */
export function paintSingNoLyrics(kind) {
  const box = $("singEmpty");
  if (!box || kind === shownKind) return;
  shownKind = kind;
  box.hidden = !kind;
  if (kind) paintNoLyricsText();
}

function onTranscribeChange() {
  if (shownKind) paintNoLyricsText();
}

function onOpenLyricsClick() {
  leave();
  openInspectorTab(INSPECTOR_TABS.LYRICS);
}

/** `leaveStage()` closes Stage before the Lyrics tab opens. */
export function initSingNoLyrics({ leaveStage }) {
  leave = leaveStage;
  $("singTranscribeBtn")?.addEventListener("click", startTranscription);
  $("singOpenLyricsBtn")?.addEventListener("click", onOpenLyricsClick);
  document.addEventListener(TRANSCRIBE_CHANGE_EVENT, onTranscribeChange);
  onLanguageChange(onTranscribeChange);
}
