// The section blocks' click and loop button, and which section is current and which loops,
// on the blocks and on the columns that carry each section down the lanes.

import { COLUMNS_ID, SECTIONS_CHANGED_EVENT, SECTION_SELECTOR, getSections } from "./sections.js";
import { sectionsAround } from "./footerSections.js";
import { loopedSection } from "./loopName.js";
import { loopEnabled, loopEnd, loopStart } from "./state.js";
import { setLoopRange, setPlayheadTime, toggleLoop } from "./transport.js";
import { onLoopChange, onPlayheadMove } from "./studioSignals.js";
import { $ } from "./utils.js";

const TRACK_ID = "daw-sections-track";
const CURRENT_CLASS = "is-current";
const LOOPED_CLASS = "is-looped";

let sections = [];
let lastSec = 0;
const painted = { current: undefined, looped: undefined };

const currentLoop = () => ({ enabled: loopEnabled, start: loopStart, end: loopEnd });

function markedElements() {
  return [
    ...($(TRACK_ID)?.querySelectorAll(SECTION_SELECTOR.BLOCK) ?? []),
    ...($(COLUMNS_ID)?.children ?? []),
  ];
}

function paintCurrent(sec) {
  lastSec = sec;
  const id = sectionsAround(sections, sec).current?.id ?? null;
  if (painted.current === id) return;
  painted.current = id;
  for (const el of markedElements()) el.classList.toggle(CURRENT_CLASS, el.dataset.id === id);
}

function paintLooped() {
  const id = loopedSection(currentLoop(), sections)?.id ?? null;
  if (painted.looped === id) return;
  painted.looped = id;
  for (const block of $(TRACK_ID)?.querySelectorAll(SECTION_SELECTOR.BLOCK) ?? []) {
    const looped = block.dataset.id === id;
    block.classList.toggle(LOOPED_CLASS, looped);
    block.querySelector(SECTION_SELECTOR.LOOP)?.setAttribute("aria-pressed", String(looped));
  }
}

function onSectionsChanged() {
  sections = getSections();
  painted.current = undefined;
  painted.looped = undefined;
  paintCurrent(lastSec);
  paintLooped();
}

function loopSection(section) {
  if (loopedSection(currentLoop(), [section])) toggleLoop();
  else setLoopRange(section.start, section.end);
}

function onSectionsTrackClick(e) {
  const block = e.target.closest(SECTION_SELECTOR.BLOCK);
  if (!block || e.target.closest(SECTION_SELECTOR.HANDLE)) return;
  if (block.dataset.dragged) {
    delete block.dataset.dragged;
    return;
  }
  const section = sections.find((s) => s.id === block.dataset.id);
  if (!section) return;
  if (e.target.closest(SECTION_SELECTOR.LOOP)) loopSection(section);
  else setPlayheadTime(section.start);
}

export function initSectionBar() {
  $(TRACK_ID)?.addEventListener("click", onSectionsTrackClick);
  document.addEventListener(SECTIONS_CHANGED_EVENT, onSectionsChanged);
  onPlayheadMove(paintCurrent);
  onLoopChange(paintLooped);
  onSectionsChanged();
}
