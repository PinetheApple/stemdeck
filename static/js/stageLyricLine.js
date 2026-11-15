// A lyric line written into Stage only when its text changes, tagged with its language.

import { tagLang } from "./lyrics.js";
import { GAP_LINE, setTextOnce } from "./stageModel.js";

/** What a lyric line shows: its words, a note for an instrumental gap, nothing for no line. */
export const lineText = (line) => (line ? line.text || GAP_LINE : "");

export function setLyric(painted, key, el, text) {
  if (!el || painted[key] === text) return;
  setTextOnce(painted, key, el, text);
  el.removeAttribute("lang");
  tagLang(el, text);
}
