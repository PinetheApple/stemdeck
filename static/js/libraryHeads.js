// The list layout's column heads: each column but Folder sorts the library when clicked.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { DIRECTIONS, SORT_KEYS, nextSortOnHeader } from "./librarySort.js";
import { isArrangedView, selectScopeOf } from "./libraryArrange.js";
import { libraryView, selection, setSort } from "./libraryView.js";

export const ON_CLASS = "is-on";
const PICKING_CLASS = "is-picking";
const HIDDEN_TEXT_CLASS = "library-sr-only";
const COLUMN_SORTS = Object.freeze({
  "c-title": SORT_KEYS.TITLE,
  "c-artist": SORT_KEYS.ARTIST,
  "c-key": SORT_KEYS.KEY,
  "c-tempo": SORT_KEYS.TEMPO,
  "c-length": SORT_KEYS.LENGTH,
  "c-added": SORT_KEYS.ADDED,
});
export const DIRECTION_ICONS = Object.freeze({ [DIRECTIONS.ASC]: "up", [DIRECTIONS.DESC]: "down" });
const DIRECTION_LABEL_KEYS = Object.freeze({ [DIRECTIONS.ASC]: "libSort.ascending", [DIRECTIONS.DESC]: "libSort.descending" });

function headCell(cls) {
  const cell = document.createElement("span");
  cell.className = `cell ${cls}`;
  return cell;
}

function plainCell(cls, label) {
  const cell = headCell(cls);
  cell.textContent = label;
  return cell;
}

function sortCell(cls, label, sortKey) {
  const { sort, dir } = libraryView();
  const on = sort === sortKey;
  const cell = headCell(cls);
  cell.classList.toggle(ON_CLASS, on);
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.sort = sortKey;
  button.setAttribute("aria-pressed", String(on));
  button.title = t("libSort.sortByColumn", { column: label });
  button.innerHTML = on
    ? `<span></span><span class="${HIDDEN_TEXT_CLASS}"></span>${icon(DIRECTION_ICONS[dir])}`
    : "<span></span>";
  button.firstChild.textContent = label;
  if (on) button.children[1].textContent = t(DIRECTION_LABEL_KEYS[dir]);
  cell.append(button);
  return cell;
}

function onHeadClick(e) {
  const button = e.target.closest("button[data-sort]");
  if (button) setSort(nextSortOnHeader(libraryView(), button.dataset.sort));
}

/** The column heads for `columns` ([class, label key] pairs); they sort only where the view does. */
export function sortableHeadEl(columns, kind) {
  const head = document.createElement("div");
  head.className = "browse-thead";
  head.classList.toggle(PICKING_CLASS, selection.picking && Boolean(selectScopeOf(kind)));
  const sorts = isArrangedView(kind);
  for (const [cls, labelKey] of columns) {
    const sortKey = sorts ? COLUMN_SORTS[cls] : null;
    head.append(sortKey ? sortCell(cls, t(labelKey), sortKey) : plainCell(cls, t(labelKey)));
  }
  head.append(plainCell("c-acts", ""));
  head.addEventListener("click", onHeadClick);
  return head;
}
