// The footer's "current section · next section" line for the playing song.

import { SECTIONS_CHANGED_EVENT, getSections, sectionDisplayName } from "./sections.js";
import { t } from "./i18n.js";

const LINE_ID = "footerNowSections";

let lastSec = 0;

/** The section playing at `sec` and the one after it, either null. */
export function sectionsAround(sections, sec) {
  const at = sections.findIndex((s) => s.start <= sec && sec < s.end);
  if (at >= 0) return { current: sections[at], next: sections[at + 1] ?? null };
  return { current: null, next: sections.find((s) => s.start > sec) ?? null };
}

function lineFor(sec) {
  const sections = getSections();
  const { current, next } = sectionsAround(sections, sec);
  const name = (s) => sectionDisplayName(s, sections);
  if (current && next) return t("studio.footer.sectionAndNext", { current: name(current), next: name(next) });
  if (next) return t("studio.footer.sectionNext", { next: name(next) });
  return current ? name(current) : "";
}

/** Written only when the text changes: this runs every frame while playing. */
export function paintSectionLine(sec) {
  lastSec = sec;
  const el = document.getElementById(LINE_ID);
  if (!el) return;
  const line = lineFor(sec);
  if (el.textContent !== line) el.textContent = line;
}

function repaintSectionLine() {
  paintSectionLine(lastSec);
}

export function initSectionLine() {
  document.addEventListener(SECTIONS_CHANGED_EVENT, repaintSectionLine);
}
