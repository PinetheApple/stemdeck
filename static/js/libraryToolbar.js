// Browse library's Sort, Filter and Select buttons, beside the search.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { DIRECTIONS, SORT_KEYS, SORT_LABEL_KEYS } from "./librarySort.js";
import { activeFilterCount } from "./libraryFilter.js";
import { isArrangedView, selectScopeOf } from "./libraryArrange.js";
import { libraryView, selection } from "./libraryView.js";
import { openFilterMenu, openSortMenu } from "./libraryMenus.js";

export const SORT_BUTTON_ID = "librarySortBtn";
export const FILTER_BUTTON_ID = "libraryFilterBtn";
export const SELECT_BUTTON_ID = "librarySelectBtn";
const ON_CLASS = "is-on";
const DIRECTION_ICONS = Object.freeze({ [DIRECTIONS.ASC]: "up", [DIRECTIONS.DESC]: "down" });

const button = (id) => document.getElementById(id);

function paintToggle(el, on) {
  el.classList.toggle(ON_CLASS, on);
  el.setAttribute("aria-pressed", String(on));
}

function paintSortButton(el) {
  const { sort, dir } = libraryView();
  el.innerHTML = sort === SORT_KEYS.MY_ORDER ? "<span></span>" : `${icon(DIRECTION_ICONS[dir])}<span></span>`;
  el.lastChild.textContent = t(SORT_LABEL_KEYS[sort]);
}

function paintFilterButton(el) {
  const count = activeFilterCount(libraryView().filters);
  el.innerHTML = `${icon("sliders")}<span></span>`;
  el.lastChild.textContent = count ? t("libSort.filterCount", { count }) : t("libSort.filter");
  paintToggle(el, count > 0);
}

function paintSelectButton(el) {
  el.innerHTML = `${icon("check")}<span></span>`;
  el.lastChild.textContent = t("libSort.select");
  paintToggle(el, selection.picking);
}

/** Show the buttons that work in a view of `kind`, each with its current state. */
export function paintLibraryToolbar(kind) {
  const [sort, filter, select] = [SORT_BUTTON_ID, FILTER_BUTTON_ID, SELECT_BUTTON_ID].map(button);
  if (!sort || !filter || !select) return;
  sort.hidden = !isArrangedView(kind);
  filter.hidden = !isArrangedView(kind);
  select.hidden = !selectScopeOf(kind);
  paintSortButton(sort);
  paintFilterButton(filter);
  paintSelectButton(select);
}

function onSortButtonClick(e) {
  openSortMenu(e.currentTarget);
}

function onFilterButtonClick(e) {
  openFilterMenu(e.currentTarget);
}

export function initLibraryToolbar({ onSelectToggle }) {
  button(SORT_BUTTON_ID)?.addEventListener("click", onSortButtonClick);
  button(FILTER_BUTTON_ID)?.addEventListener("click", onFilterButtonClick);
  button(SELECT_BUTTON_ID)?.addEventListener("click", onSelectToggle);
}
