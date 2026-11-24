// Browse library's Sort and Filter menus, opened under their toolbar buttons.

import { t } from "./i18n.js";
import { menuItem, menuSeparator, openMenu } from "./trackMenu.js";
import { DIRECTIONS, SORT_KEYS, SORT_LABEL_KEYS } from "./librarySort.js";
import { KEY_MODE_OPTIONS, TEMPO_OPTIONS, activeFilterCount, clearFilters } from "./libraryFilter.js";
import { libraryView, setFilters, setSort } from "./libraryView.js";

const MENU_GAP_PX = 4;
const WINDOW_MARGIN_PX = 8;
const CHECK_ICON = "check";
const CLEAR_ICON = "x";
const RADIO_ROLE = "menuitemradio";
const CHECKBOX_ROLE = "menuitemcheckbox";
const FAVORITES_FILTER = "favoritesOnly";
const DIRECTION_ITEMS = [
  [DIRECTIONS.ASC, "libSort.ascending"],
  [DIRECTIONS.DESC, "libSort.descending"],
];

/** Under the anchor, left edges level, held inside the window. */
export function placeUnder(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - width - WINDOW_MARGIN_PX);
  const top = Math.min(rect.bottom + MENU_GAP_PX, window.innerHeight - height - WINDOW_MARGIN_PX);
  el.style.left = `${Math.max(WINDOW_MARGIN_PX, left)}px`;
  el.style.top = `${Math.max(WINDOW_MARGIN_PX, top)}px`;
}

export function menuHeading(text) {
  const heading = document.createElement("div");
  heading.className = "lib-menu-label";
  heading.textContent = text;
  return heading;
}

function checkItem(text, checked, onChoose, { role = RADIO_ROLE, disabled = false, key = "" } = {}) {
  const item = menuItem(text, CHECK_ICON, onChoose, { disabled });
  item.setAttribute("role", role);
  item.setAttribute("aria-checked", String(checked));
  item.dataset.choice = key;
  return item;
}

function sortItem(key) {
  const { sort, dir } = libraryView();
  return checkItem(t(SORT_LABEL_KEYS[key]), key === sort, function onSortChoose() {
    setSort({ sort: key, dir });
  });
}

function directionItem([dir, labelKey]) {
  const { sort } = libraryView();
  const onDirectionChoose = () => setSort({ sort, dir });
  const disabled = sort === SORT_KEYS.MY_ORDER;
  return checkItem(t(labelKey), dir === libraryView().dir, onDirectionChoose, { disabled });
}

export function openSortMenu(anchor) {
  const items = [
    menuHeading(t("libSort.sortBy")),
    ...Object.values(SORT_KEYS).map(sortItem),
    menuSeparator(),
    ...DIRECTION_ITEMS.map(directionItem),
  ];
  openMenu(anchor, items, { label: t("libSort.sortBy"), place: placeUnder });
}

// A filter item keeps the menu open: it opens again at once, on the item chosen.
function filterItem(anchor, label, checked, next, { role = RADIO_ROLE, key }) {
  return checkItem(label, checked, function onFilterChoose() {
    setFilters(next);
    openFilterMenu(anchor);
    document.querySelector(`.lib-menu [data-choice="${CSS.escape(key)}"]`)?.focus();
  }, { role, key });
}

function optionItems(anchor, field, options) {
  const { filters } = libraryView();
  return options.map((option) => filterItem(
    anchor,
    t(option.label, option.vars),
    filters[field] === option.value,
    { ...filters, [field]: option.value },
    { key: `${field}:${option.value}` },
  ));
}

function clearItem() {
  const disabled = activeFilterCount(libraryView().filters) === 0;
  return menuItem(t("libSort.clearFilters"), CLEAR_ICON, function onClearFilters() {
    setFilters(clearFilters());
  }, { disabled });
}

export function openFilterMenu(anchor) {
  const { filters } = libraryView();
  const favoritesOnly = { ...filters, favoritesOnly: !filters.favoritesOnly };
  const items = [
    filterItem(anchor, t("libSort.favoritesOnly"), filters.favoritesOnly, favoritesOnly, { role: CHECKBOX_ROLE, key: FAVORITES_FILTER }),
    menuHeading(t("inspector.tempo")),
    ...optionItems(anchor, "tempo", TEMPO_OPTIONS),
    menuHeading(t("meta.key")),
    ...optionItems(anchor, "mode", KEY_MODE_OPTIONS),
    menuSeparator(),
    clearItem(),
  ];
  openMenu(anchor, items, { label: t("libSort.filter"), place: placeUnder });
}
