// Inspector tab switching; the modules that own each tab fill it.

import { $, storeGet, storeSet } from "./utils.js";

const TAB_STORE_KEY = "stemdeck.inspector.tab";
const DEFAULT_TAB = "tempo";
const HIDDEN_STORE_KEY = "stemdeck.inspector.hidden";
const HIDDEN_CLASS = "inspector-hidden";
const HIDDEN_STORED = "1";
const SHOWN_STORED = "0";

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

async function restoreInspectorTab() {
  showInspectorTab(await storeGet(TAB_STORE_KEY, DEFAULT_TAB));
}

function setInspectorHidden(hidden) {
  document.querySelector(".app")?.classList.toggle(HIDDEN_CLASS, hidden);
  $("inspectorToggleBtn")?.setAttribute("aria-expanded", String(!hidden));
}

function saveInspectorHidden(hidden) {
  try {
    localStorage.setItem(HIDDEN_STORE_KEY, hidden ? HIDDEN_STORED : SHOWN_STORED);
  } catch (e) {
    console.warn("[inspector] could not persist hidden state:", e);
  }
}

function readInspectorHidden() {
  try {
    return localStorage.getItem(HIDDEN_STORE_KEY) === HIDDEN_STORED;
  } catch (e) {
    console.warn("[inspector] could not read hidden state:", e);
    return false;
  }
}

function onInspectorToggleClick(e) {
  const hidden = e.currentTarget.getAttribute("aria-expanded") === "true";
  setInspectorHidden(hidden);
  saveInspectorHidden(hidden);
}

export function initInspector() {
  const tablist = document.querySelector(".inspector-tabs");
  if (!tablist) return;
  setInspectorHidden(readInspectorHidden());
  tablist.addEventListener("click", onTabClick);
  tablist.addEventListener("keydown", onTabKeydown);
  $("inspectorToggleBtn")?.addEventListener("click", onInspectorToggleClick);
  showInspectorTab(DEFAULT_TAB);
  restoreInspectorTab().catch(console.error);
}
