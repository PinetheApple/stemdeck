// Stage's cue in Play along: the section playing, what follows it and in how many bars, and the next section's time.

import { totalDuration } from "./state.js";
import { getSections, sectionDisplayName } from "./sections.js";
import { barsUntil } from "./stageBeats.js";
import { paintStageSections } from "./stageOverview.js";
import { setTextOnce } from "./stageModel.js";
import { EMPTY_VALUE } from "./constants.js";
import { t, plural } from "./i18n.js";
import { $, fmtTime } from "./utils.js";

const PLACEHOLDER = /\{(\w+)\}/;

let sections = [];
let sectionsKey = "";
const shown = { section: null, then: null, next: null };

/** Reads the song's sections, drawing the overview's blocks again when they changed. */
export function readCueSections() {
  const all = getSections();
  sections = all.map((s) => ({ start: s.start, end: s.end, name: sectionDisplayName(s, all) }));
  const key = JSON.stringify([totalDuration, sections]);
  if (key === sectionsKey) return;
  sectionsKey = key;
  paintStageSections(sections);
}

function sectionsAt(time) {
  const at = sections.findLastIndex((s) => s.start <= time);
  return { at, current: sections[at] ?? null, next: sections[at + 1] ?? null };
}

function nextLabel(time, next) {
  if (!sections.length) return EMPTY_VALUE;
  if (!next) return t("stage.lastSection");
  return t("stage.nextIn", { name: next.name, time: fmtTime(Math.max(0, next.start - time)) });
}

/** Fills `el` with `template`, each {placeholder} in bold. */
function fillTemplate(el, template, vars) {
  const parts = template.split(PLACEHOLDER).map((part, i) => {
    if (i % 2 === 0) return part;
    const bold = document.createElement("b");
    bold.textContent = String(vars[part] ?? "");
    return bold;
  });
  el.replaceChildren(...parts);
}

function paintThen(time, next, beatTable) {
  const el = $("stageThen");
  const name = next?.name ?? t("stage.end");
  const count = sections.length ? barsUntil(beatTable, time, next?.start ?? totalDuration) : null;
  const key = sections.length ? `${name}\u0000${count}` : "";
  if (!el || shown.then === key) return;
  shown.then = key;
  if (!sections.length) el.replaceChildren();
  else if (count === null) fillTemplate(el, t("stage.then"), { name });
  else fillTemplate(el, plural("stage.thenBars", count), { name, count });
}

/** One frame of the cue at `time`; returns the index of the section playing, or -1. */
export function paintCue(time, beatTable) {
  const { at, current, next } = sectionsAt(time);
  setTextOnce(shown, "section", $("stageSection"), current?.name ?? "");
  setTextOnce(shown, "next", $("stageNext"), nextLabel(time, next));
  paintThen(time, next, beatTable);
  return at;
}

/** Entering Stage, a new song or a new language: the next frame writes everything again. */
export function forgetCue() {
  for (const key of Object.keys(shown)) shown[key] = null;
  sectionsKey = "";
}
