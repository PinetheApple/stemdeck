// The footer Loop's name for what loops, and its options' Set start here, Set end here and Clear loop.

import { SECTIONS_CHANGED_EVENT, getSections, sectionDisplayName } from "./sections.js";
import { loopedSection } from "./loopName.js";
import {
  loopEnabled,
  loopEnd,
  loopStart,
  setLoopEnabled,
  setLoopEnd,
  setLoopStart,
  totalDuration,
} from "./state.js";
import { LOOP_DEFAULT_END_FRAC, LOOP_DEFAULT_START_FRAC } from "./constants.js";
import { onLanguageChange, t } from "./i18n.js";
import { $ } from "./utils.js";

const NAME_ID = "t-loop-name";
const OFF_KEY = "position.loopLabel";
const REGION_KEY = "studio.footer.loopRegion";
/** The shortest loop that Set start here, Set end here and the I and O keys leave. */
export const LOOP_EDGE_MIN_SEC = 0.5;

function loopLabel() {
  if (!loopEnabled) return t(OFF_KEY);
  const sections = getSections();
  const section = loopedSection({ enabled: loopEnabled, start: loopStart, end: loopEnd }, sections);
  return section ? sectionDisplayName(section, sections) : t(REGION_KEY);
}

export function paintLoopName() {
  const el = $(NAME_ID);
  if (el) el.textContent = loopLabel();
}

/** Called by transport.js with its own loop functions: it imports this module, so this one cannot import it. */
export function initFooterLoop({ currentTime, setLoopRange, updateLoopRegionVisual }) {
  $("t-loop-start-here")?.addEventListener("click", function onLoopStartHere() {
    setLoopRange(Math.min(currentTime(), loopEnd - LOOP_EDGE_MIN_SEC), loopEnd);
  });
  $("t-loop-end-here")?.addEventListener("click", function onLoopEndHere() {
    setLoopRange(loopStart, Math.min(totalDuration, Math.max(currentTime(), loopStart + LOOP_EDGE_MIN_SEC)));
  });
  $("t-loop-clear")?.addEventListener("click", function onClearLoop() {
    setLoopEnabled(false);
    setLoopStart(totalDuration * LOOP_DEFAULT_START_FRAC);
    setLoopEnd(totalDuration * LOOP_DEFAULT_END_FRAC);
    updateLoopRegionVisual();
  });
  document.addEventListener(SECTIONS_CHANGED_EVENT, paintLoopName);
  onLanguageChange(paintLoopName);
  paintLoopName();
}
