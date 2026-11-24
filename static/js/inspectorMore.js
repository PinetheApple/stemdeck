// The song tools' tabs that don't fit the panel's width go into a More menu;
// the open tab always stays in the row.

import { $ } from "./utils.js";
import { t, getLanguage, onLanguageChange } from "./i18n.js";
import { openMenu } from "./trackMenu.js";
import { keepInWindow } from "./shellFloat.js";
import { overflowTabs } from "./inspectorTabFit.js";

const SELECTED_TAB = '[aria-selected="true"]';
const COUNT_SHOWN = ".inspector-count:not([hidden])";
const MENU_ITEM_CLASS = "lib-menu-item";
const COUNT_CHANGES = Object.freeze({
  childList: true,
  characterData: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["hidden"],
});

const tabbar = () => document.querySelector(".inspector-tabbar");
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

export function fitInspectorTabs(all) {
  const bar = tabbar();
  const more = $("inspectorMoreBtn");
  if (!bar?.clientWidth || !more) return;
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

function moreItem(tab, onChoose) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = MENU_ITEM_CLASS;
  item.setAttribute("role", "menuitem");
  const label = document.createElement("span");
  label.textContent = tabLabel(tab);
  item.append(label);
  item.addEventListener("click", function onMoreItemClick() {
    onChoose(tab);
  });
  return item;
}

function watchTabWidths(bar, refit) {
  new ResizeObserver(refit).observe(bar);
  const count = $("upNextCount");
  if (count) new MutationObserver(refit).observe(count, COUNT_CHANGES);
  onLanguageChange(refit);
}

/** `tabs()` lists the tab buttons; `choose(name)` opens one as a click on it does, and returns it. */
export function initInspectorMore({ tabs, choose }) {
  const more = $("inspectorMoreBtn");
  const bar = tabbar();
  if (!more || !bar) return;

  function refit() {
    fitInspectorTabs(tabs());
  }

  // openMenu() closes the menu when asked again from the same button.
  function onMoreTabChosen(tab) {
    more.click();
    choose(tab.dataset.tab)?.focus();
  }

  function onMoreClick() {
    const items = tabs().filter((tab) => tab.hidden).map((tab) => moreItem(tab, onMoreTabChosen));
    openMenu(more, items, { label: t("panel.more"), place: keepInWindow });
  }

  more.addEventListener("click", onMoreClick);
  watchTabWidths(bar, refit);
  refit();
}
