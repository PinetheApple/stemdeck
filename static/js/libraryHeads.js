// The list layout's column heads: each column but Folder sorts the library when clicked.

import { t } from "./i18n.js";
import { icon } from "./libraryIcons.js";
import { DIRECTIONS, SORT_KEYS, nextSortOnHeader } from "./librarySort.js";
import { isArrangedView, selectScopeOf } from "./libraryArrange.js";
import { libraryView, selection, setSort } from "./libraryView.js";

export const ON_CLASS = "is-on";
const PICKING_CLASS = "is-picking";
const HEAD_ROLE = "row";
const CELL_ROLE = "columnheader";
const COLUMN_SORTS = Object.freeze({
  "c-title": SORT_KEYS.TITLE,
  "c-artist": SORT_KEYS.ARTIST,
  "c-key": SORT_KEYS.KEY,
  "c-tempo": SORT_KEYS.TEMPO,
  "c-length": SORT_KEYS.LENGTH,
  "c-added": SORT_KEYS.ADDED,
});
export const DIRECTION_ICONS = Object.freeze({ [DIRECTIONS.ASC]: "up", [DIRECTIONS.DESC]: "down" });
const ARIA_SORT = Object.freeze({ [DIRECTIONS.ASC]: "ascending", [DIRECTIONS.DESC]: "descending" });

function headCell(cls) {
  const cell = document.createElement("span");
  cell.className = `cell ${cls}`;
  cell.setAttribute("role", CELL_ROLE);
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
  if (on) cell.setAttribute("aria-sort", ARIA_SORT[dir]);
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.sort = sortKey;
  button.title = t("libSort.sortByColumn", { column: label });
  button.innerHTML = `<span></span>${on ? icon(DIRECTION_ICONS[dir]) : ""}`;
  button.firstChild.textContent = label;
  cell.append(button);
  return cell;
}

function onHeadClick(e) {
  const cell = e.target.closest("button[data-sort]");
  if (cell) setSort(nextSortOnHeader(libraryView(), cell.dataset.sort));
}

/** The column heads for `columns` ([class, label key] pairs); they sort only where the view does. */
export function sortableHeadEl(columns, kind) {
  const head = document.createElement("div");
  head.className = "browse-thead";
  head.setAttribute("role", HEAD_ROLE);
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
