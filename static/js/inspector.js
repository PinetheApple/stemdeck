// Inspector tab switching and the Tempo tab's readout; the modules that own each tab fill it.

import { getCurrentTrackInfo } from "./catalog.js";
import { EMPTY_VALUE } from "./constants.js";
import { $, storeGet, storeSet } from "./utils.js";

const TAB_STORE_KEY = "stemdeck.inspector.tab";
const DEFAULT_TAB = "tempo";

const tabs = () => [...document.querySelectorAll(".inspector-tab[data-tab]")];

/** Show one tab's pane and hide the others. Unknown names fall back to Tempo. */
function showInspectorTab(name) {
  const all = tabs();
  const target = all.find((tab) => tab.dataset.tab === name) ?? all.find((tab) => tab.dataset.tab === DEFAULT_TAB);
  if (!target) return null;
  for (const tab of all) {
    const selected = tab === target;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const pane = $(tab.getAttribute("aria-controls"));
    if (pane) pane.hidden = !selected;
  }
  return target;
}

function chooseInspectorTab(name) {
  const shown = showInspectorTab(name);
  if (shown) storeSet(TAB_STORE_KEY, shown.dataset.tab);
}

function onTabClick(e) {
  const tab = e.target.closest(".inspector-tab[data-tab]");
  if (tab) chooseInspectorTab(tab.dataset.tab);
}

function onTabKeydown(e) {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  if (!step) return;
  const all = tabs();
  const at = all.indexOf(document.activeElement);
  if (at < 0) return;
  e.preventDefault();
  const next = all[(at + step + all.length) % all.length];
  chooseInspectorTab(next.dataset.tab);
  next.focus();
}

function paintTempoReadout() {
  const readout = $("tempoReadout");
  if (!readout) return;
  const bpm = getCurrentTrackInfo()?.bpm;
  readout.textContent = bpm ? String(bpm) : EMPTY_VALUE;
}

async function restoreInspectorTab() {
  showInspectorTab(await storeGet(TAB_STORE_KEY, DEFAULT_TAB));
}

export function initInspector() {
  const tablist = document.querySelector(".inspector-tabs");
  if (!tablist) return;
  tablist.addEventListener("click", onTabClick);
  tablist.addEventListener("keydown", onTabKeydown);
  showInspectorTab(DEFAULT_TAB);
  restoreInspectorTab().catch(console.error);
  document.addEventListener("trackopen", paintTempoReadout);
}
