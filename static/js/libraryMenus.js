// Browse library's Sort and Filter menus, opened under their toolbar buttons.

import { t } from "./i18n.js";
import { menuItem, menuLabel, menuSeparator, openMenu, placeBelow } from "./floatMenu.js";
import { DIRECTIONS, SORT_KEYS, SORT_LABEL_KEYS } from "./librarySort.js";
import { FILTER_FIELDS, KEY_MODE_OPTIONS, TEMPO_OPTIONS, activeFilterCount } from "./libraryFilter.js";
import { clearLibraryFilters, libraryView, setFilters, setSort } from "./libraryView.js";

const CHECK_ICON = "check";
const CLEAR_ICON = "x";
const RADIO_ROLE = "menuitemradio";
const CHECKBOX_ROLE = "menuitemcheckbox";
const DIRECTION_ITEMS = [
  [DIRECTIONS.ASC, "libSort.ascending"],
  [DIRECTIONS.DESC, "libSort.descending"],
];

function checkItem(text, checked, onChoose, { role = RADIO_ROLE, disabled = false, key = "" } = {}) {
  const item = menuItem(text, CHECK_ICON, onChoose, { disabled });
  item.setAttribute("role", role);
  item.setAttribute("aria-checked", String(checked));
  item.dataset.choice = key;
  return item;
}

function sortItem(key) {
  const { sort, dir } = libraryView();
  function onSortChoose() {
    setSort({ sort: key, dir });
  }
  return checkItem(t(SORT_LABEL_KEYS[key]), key === sort, onSortChoose);
}

function directionItem([dir, labelKey]) {
  const { sort } = libraryView();
  function onDirectionChoose() {
    setSort({ sort, dir });
  }
  const disabled = sort === SORT_KEYS.MY_ORDER;
  return checkItem(t(labelKey), dir === libraryView().dir, onDirectionChoose, { disabled });
}

export function openSortMenu(anchor) {
  const items = [
    menuLabel(t("libSort.sortBy")),
    ...Object.values(SORT_KEYS).map(sortItem),
    menuSeparator(),
    ...DIRECTION_ITEMS.map(directionItem),
  ];
  openMenu(anchor, items, { label: t("libSort.sortBy"), place: placeBelow });
}

// A filter item keeps the menu open: it opens again at once, on the item chosen.
function filterItem(anchor, label, checked, next, { role = RADIO_ROLE, key }) {
  function onFilterChoose() {
    setFilters(next);
    openFilterMenu(anchor);
    document.querySelector(`.lib-menu [data-choice="${CSS.escape(key)}"]`)?.focus();
  }
  return checkItem(label, checked, onFilterChoose, { role, key });
}

function optionItem(anchor, field, option) {
  const { filters } = libraryView();
  return filterItem(
    anchor,
    t(option.label, option.vars),
    filters[field] === option.value,
    { ...filters, [field]: option.value },
    { key: `${field}:${option.value}` },
  );
}

function optionItems(anchor, field, options) {
  return options.map((option) => optionItem(anchor, field, option));
}

function favoritesItem(anchor) {
  const { filters } = libraryView();
  const field = FILTER_FIELDS.FAVORITES_ONLY;
  return filterItem(
    anchor,
    t("libSort.favoritesOnly"),
    filters[field],
    { ...filters, [field]: !filters[field] },
    { role: CHECKBOX_ROLE, key: field },
  );
}

function clearItem() {
  const disabled = activeFilterCount(libraryView().filters) === 0;
  return menuItem(t("libSort.clearFilters"), CLEAR_ICON, clearLibraryFilters, { disabled });
}

export function openFilterMenu(anchor) {
  const items = [
    favoritesItem(anchor),
    menuLabel(t("inspector.tempo")),
    ...optionItems(anchor, FILTER_FIELDS.TEMPO, TEMPO_OPTIONS),
    menuLabel(t("meta.key")),
    ...optionItems(anchor, FILTER_FIELDS.MODE, KEY_MODE_OPTIONS),
    menuSeparator(),
    clearItem(),
  ];
  openMenu(anchor, items, { label: t("libSort.filter"), place: placeBelow });
}
