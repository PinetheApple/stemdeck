// The song tools' tab switching; the modules that own each tab fill it.

import { $, storeGet, storeSet } from "./utils.js";
import { TOOLS_HIDDEN_CLASS, isToolsAutoHidden } from "./shellEdges.js";
import { fitInspectorTabs, initInspectorMore } from "./inspectorMore.js";

const TAB_STORE_KEY = "stemdeck.inspector.tab";
const DEFAULT_TAB = "lyrics";
const HIDDEN_STORE_KEY = "stemdeck.inspector.hidden";
const HIDDEN_STORED = "1";
const SHOWN_STORED = "0";
const TAB_SELECTOR = ".inspector-tab[data-tab]";
const TAB_KEY_STEPS = Object.freeze({ ArrowRight: 1, ArrowLeft: -1 });
/** Fired on document with { tab }: the tab now on screen, or null while the song tools are hidden. */
export const INSPECTOR_TAB_SHOWN_EVENT = "inspectortabshown";

let announcedTab;

const app = () => document.querySelector(".app");
const tabs = () => [...document.querySelectorAll(TAB_SELECTOR)];
const selectedTab = () => tabs().find((tab) => tab.getAttribute("aria-selected") === "true") ?? null;
const isHiddenByUser = () => Boolean(app()?.classList.contains(TOOLS_HIDDEN_CLASS));

/** The tab on screen, or null while the song tools are hidden or stepped aside. */
export function shownInspectorTab() {
  if (isHiddenByUser() || isToolsAutoHidden()) return null;
  return selectedTab()?.dataset.tab ?? null;
}

function announceShownTab() {
  const tab = shownInspectorTab();
  if (tab === announcedTab) return;
  announcedTab = tab;
  document.dispatchEvent(new CustomEvent(INSPECTOR_TAB_SHOWN_EVENT, { detail: { tab } }));
}

/** Show one tab's pane and hide the others. Unknown names fall back to Lyrics. */
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
  fitInspectorTabs();
  announceShownTab();
  return target;
}

function chooseInspectorTab(name) {
  const shown = showInspectorTab(name);
  if (shown) storeSet(TAB_STORE_KEY, shown.dataset.tab);
  return shown;
}

function onTabClick(e) {
  const tab = e.target.closest(TAB_SELECTOR);
  if (tab) chooseInspectorTab(tab.dataset.tab);
}

function onTabKeydown(e) {
  const step = TAB_KEY_STEPS[e.key];
  if (!step) return;
  const all = tabs();
  const at = all.indexOf(document.activeElement);
  if (at < 0) return;
  e.preventDefault();
  chooseInspectorTab(all[(at + step + all.length) % all.length].dataset.tab)?.focus();
}

async function restoreInspectorTab() {
  let name = DEFAULT_TAB;
  try {
    name = await storeGet(TAB_STORE_KEY, DEFAULT_TAB);
  } catch (e) {
    console.warn("[inspector] could not read the last tab:", e);
  }
  showInspectorTab(name);
}

function setInspectorHidden(hidden) {
  app()?.classList.toggle(TOOLS_HIDDEN_CLASS, hidden);
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

/** Show a tab from elsewhere in the app (a lane's EQ, the footer's Up Next), unhiding the song tools. */
export function openInspectorTab(name) {
  setInspectorHidden(false);
  saveInspectorHidden(false);
  return chooseInspectorTab(name);
}

function onInspectorToggleClick() {
  const hidden = !isHiddenByUser();
  setInspectorHidden(hidden);
  saveInspectorHidden(hidden);
}

function watchShownTab() {
  const root = app();
  if (root) new MutationObserver(announceShownTab).observe(root, { attributes: true, attributeFilter: ["class"] });
}

export function initInspector() {
  const tablist = document.querySelector(".inspector-tabs");
  if (!tablist) return;
  setInspectorHidden(readInspectorHidden());
  tablist.addEventListener("click", onTabClick);
  tablist.addEventListener("keydown", onTabKeydown);
  $("inspectorToggleBtn")?.addEventListener("click", onInspectorToggleClick);
  initInspectorMore({ choose: chooseInspectorTab });
  watchShownTab();
  restoreInspectorTab();
}
