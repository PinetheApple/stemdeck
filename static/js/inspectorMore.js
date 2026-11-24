// The song tools' tabs that don't fit the panel's width go into a More menu;
// the open tab always stays in the row.

import { $ } from "./utils.js";
import { t, getLanguage, onLanguageChange } from "./i18n.js";
import { openMenu, menuItem } from "./trackMenu.js";
import { keepInWindow } from "./shellFloat.js";
import { overflowTabs } from "./inspectorTabFit.js";

const TAB_SELECTOR = ".inspector-tab[data-tab]";
const SELECTED_TAB = '[aria-selected="true"]';
const COUNT_SHOWN = ".inspector-count:not([hidden])";

let chooseTab = () => null;

const tabbar = () => document.querySelector(".inspector-tabbar");
const tabs = () => [...document.querySelectorAll(TAB_SELECTOR)];
const listOf = (labels) => new Intl.ListFormat(getLanguage(), { type: "unit" }).format(labels);

function tabLabel(tab) {
  const name = tab.querySelector("[data-i18n]")?.textContent ?? "";
  const count = tab.querySelector(COUNT_SHOWN)?.textContent ?? "";
  return [name, count].filter(Boolean).join(" ");
}

function roomFor(bar) {
  const style = getComputedStyle(bar);
  return bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

function gapOf(list) {
  return parseFloat(getComputedStyle(list).columnGap) || 0;
}

function paintMore(more, hidden) {
  more.hidden = hidden.length === 0;
  more.title = t("panel.moreTitle", { tabs: listOf(hidden.map(tabLabel)) });
}

/** Measure every tab at its own width, then move the ones that don't fit into More. */
export function fitInspectorTabs() {
  const bar = tabbar();
  const more = $("inspectorMoreBtn");
  if (!bar?.clientWidth || !more) return;
  const all = tabs();
  for (const tab of all) tab.hidden = false;
  more.hidden = false;
  const hidden = overflowTabs({
    widths: all.map((tab) => tab.offsetWidth),
    open: Math.max(0, all.findIndex((tab) => tab.matches(SELECTED_TAB))),
    room: roomFor(bar),
    moreWidth: more.offsetWidth,
    gap: gapOf(bar.querySelector(".inspector-tabs")),
  }).map((index) => all[index]);
  for (const tab of hidden) tab.hidden = true;
  paintMore(more, hidden);
}

function onMoreTabChosen(tab) {
  chooseTab(tab.dataset.tab)?.focus();
}

function moreItem(tab) {
  const item = menuItem(tabLabel(tab), null, () => onMoreTabChosen(tab));
  item.querySelector("svg")?.remove();
  return item;
}

function onMoreClick(e) {
  const items = tabs().filter((tab) => tab.hidden).map(moreItem);
  openMenu(e.currentTarget, items, { label: t("panel.more"), place: keepInWindow });
}

function watchTabWidths() {
  new ResizeObserver(fitInspectorTabs).observe(tabbar());
  const count = $("upNextCount");
  const changes = { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["hidden"] };
  if (count) new MutationObserver(fitInspectorTabs).observe(count, changes);
  onLanguageChange(fitInspectorTabs);
}

/** `choose(name)` opens a tab as a click on it does, and returns it. */
export function initInspectorMore({ choose }) {
  const more = $("inspectorMoreBtn");
  if (!more || !tabbar()) return;
  chooseTab = choose;
  more.addEventListener("click", onMoreClick);
  watchTabWidths();
  fitInspectorTabs();
}
