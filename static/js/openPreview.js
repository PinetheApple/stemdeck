// The shown song's lanes come from its peaks with no decode, so the song in the
// player keeps its engine, mixer and lanes mounted underneath.

import {
  WAVE_VIEWBOX_HEIGHT,
  barsWaveformSvg,
  overviewBarCount,
  overviewLaneNames,
} from "./player.js";
import { STEM_COLORS, STEM_DISPLAY, UNKNOWN_STEM_COLOR } from "./constants.js";
import { npThumb } from "./state.js";
import { $ } from "./utils.js";

const SHOWN_CLASS = "is-previewing";
const ROW_CLASS = "open-preview-row";
const NAME_CLASS = "open-preview-name";
const LANE_CLASS = "open-preview-lane";
const LOADED_THUMB_CLASS = "loaded";

let loadedSongThumb = null;

const appEl = () => document.querySelector(".app");

export function isOpenPreviewShown() {
  return Boolean(appEl()?.classList.contains(SHOWN_CLASS));
}

function sharedNorm(names, peaks) {
  let max = 0;
  for (const name of names) {
    for (const [min, peak] of peaks[name] ?? []) max = Math.max(max, peak, -min);
  }
  return max > 0 ? 1 / max : 0;
}

function laneRow(name, peaks, norm, bars) {
  const row = document.createElement("div");
  row.className = ROW_CLASS;
  row.dataset.stem = name;
  row.style.setProperty("--stem-color", STEM_COLORS[name] || UNKNOWN_STEM_COLOR);
  const label = document.createElement("span");
  label.className = NAME_CLASS;
  label.textContent = STEM_DISPLAY[name] || name;
  const lane = document.createElement("div");
  lane.className = LANE_CLASS;
  if (peaks?.length) {
    lane.innerHTML = `<svg class="stem-waveform-svg" viewBox="0 0 ${bars} ${WAVE_VIEWBOX_HEIGHT}" `
      + `preserveAspectRatio="none" aria-hidden="true">${barsWaveformSvg(peaks, norm, bars)}</svg>`;
  }
  row.append(label, lane);
  return row;
}

function showThumb(src) {
  if (src) {
    npThumb.src = src;
    return;
  }
  npThumb.removeAttribute("src");
  npThumb.classList.remove(LOADED_THUMB_CLASS);
}

/** Draw a song's lanes over the loaded one's. */
export function showOpenPreview({ stems, peaks, thumbnail }) {
  const layer = $("openPreview");
  if (!layer) return;
  const present = new Set(stems.map((stem) => stem.name));
  const names = overviewLaneNames(stems).filter((name) => present.has(name));
  const norm = sharedNorm(names, peaks);
  const bars = overviewBarCount();
  layer.replaceChildren(...names.map((name) => laneRow(name, peaks[name], norm, bars)));
  if (!isOpenPreviewShown()) loadedSongThumb = npThumb.getAttribute("src");
  showThumb(thumbnail);
  appEl()?.classList.add(SHOWN_CLASS);
}

/** Take the shown song away; the loaded one is on screen again. */
export function clearOpenPreview() {
  if (!isOpenPreviewShown()) return;
  appEl().classList.remove(SHOWN_CLASS);
  $("openPreview")?.replaceChildren();
  showThumb(loadedSongThumb);
  loadedSongThumb = null;
}
