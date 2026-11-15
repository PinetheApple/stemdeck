// The "I play" picker: a toggle per stem in its stem colour. What is picked is
// silenced on top of the mix while Film is open; the song's mix is never written.

import { t } from "./i18n.js";
import { STEM_DISPLAY } from "./constants.js";
import { clearSilencedStems, setSilencedStems } from "./mixer.js";
import { pickableStems, silencedLanes } from "./filmIPlayModel.js";

const $ = (id) => document.getElementById(id);

// The mixer greys and hides the lanes this song has no audio for.
const LOADED_LANE_SELECTOR = ".mixer-column .lane-header[data-stem]:not(.unavailable):not(.hidden)";

function laneNames() {
  return [...document.querySelectorAll(LOADED_LANE_SELECTOR)].map((row) => row.dataset.stem);
}

/** Silence what `iPlay` names among the song's lanes. */
export function applyIPlay(iPlay) {
  setSilencedStems(silencedLanes(iPlay, laneNames()));
}

export function releaseIPlay() {
  clearSilencedStems();
}

function stemChip(stem, on, onToggle) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "film-stem";
  chip.dataset.stem = stem;
  chip.style.setProperty("--stem", `var(--${stem}, var(--text-3))`);
  chip.setAttribute("aria-pressed", String(on));
  chip.textContent = STEM_DISPLAY[stem] || stem;
  chip.addEventListener("click", function onStemToggle() {
    onToggle(stem);
  });
  return chip;
}

/** Draw the picker for `iPlay`; `onToggle(stem)` flips one stem. */
export function renderIPlay(iPlay, onToggle) {
  const group = $("filmStems");
  if (!group) return;
  const picked = new Set(iPlay);
  group.replaceChildren(...pickableStems(laneNames()).map((stem) => stemChip(stem, picked.has(stem), onToggle)));
  const note = $("filmIPlayNote");
  if (note) note.hidden = picked.size === 0;
  group.setAttribute("aria-label", t("film.iPlay"));
}

/** `iPlay` with `stem` added or removed, in the picker's order. */
export function toggledIPlay(iPlay, stem) {
  const next = new Set(iPlay);
  if (next.has(stem)) next.delete(stem);
  else next.add(stem);
  return pickableStems(laneNames()).filter((name) => next.has(name));
}
