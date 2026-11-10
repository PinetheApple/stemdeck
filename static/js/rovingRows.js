// One Tab stop per list (roving tabindex). Up/Down/Home/End move between rows, Enter
// opens one, Right/Left walk into and back out of the row's own buttons.

export const ROW_KEY = Object.freeze({
  PREVIOUS: "ArrowUp",
  NEXT: "ArrowDown",
  FIRST: "Home",
  LAST: "End",
  INTO: "ArrowRight",
  BACK: "ArrowLeft",
  OPEN: "Enter",
});

const ROVING_STOP = 0;
export const OUT_OF_TAB_ORDER = -1;
/** Where the focus sits inside a row: on the row itself rather than on one of its actions. */
export const ON_ROW = -1;

/** The row index a movement key leads to, or null for any other key. */
export function rowStep(key, index, count) {
  if (!count) return null;
  if (key === ROW_KEY.PREVIOUS) return Math.max(0, index - 1);
  if (key === ROW_KEY.NEXT) return Math.min(count - 1, index + 1);
  if (key === ROW_KEY.FIRST) return 0;
  if (key === ROW_KEY.LAST) return count - 1;
  return null;
}

/** The action index Right/Left lead to from `index` (ON_ROW for the row), or null to stay. */
export function actionStep(key, index, count) {
  if (key === ROW_KEY.INTO) return index + 1 < count ? index + 1 : null;
  if (key === ROW_KEY.BACK) return index > ON_ROW ? index - 1 : null;
  return null;
}

/** The row to land on after a redraw: the same one by key, else the one now at its place. */
export function landingIndex(keys, saved) {
  if (!keys.length) return null;
  const same = saved ? keys.indexOf(saved.key) : -1;
  if (same !== -1) return same;
  if (!saved || saved.index < 0) return null;
  return Math.min(saved.index, keys.length - 1);
}

function isShown(el) {
  return el.getClientRects().length > 0;
}

function hasModifier(e) {
  return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}

/**
 * Make `container` one Tab stop over the rows matching `rowSelector`.
 * `keyOf(row)` names a row across redraws; `openRow(row)` is what Enter does;
 * `preferredRow(rows)` picks the stop among `rows` when none was focused yet.
 * Call `remember()` before a redraw and `restore(saved)` after it, or `refresh()`
 * when rows were shown or hidden without one.
 */
export function wireRovingRows(
  container,
  { rowSelector, actionSelector, keyOf, openRow, preferredRow = () => null },
) {
  const rowOf = (el) => {
    const row = el?.closest?.(rowSelector);
    return row && container.contains(row) ? row : null;
  };
  const allRows = () => [...container.querySelectorAll(rowSelector)];
  const shownRows = () => allRows().filter(isShown);
  const actionsOf = (row) => [...row.querySelectorAll(actionSelector)].filter((el) => !el.disabled && isShown(el));

  function makeStop(row) {
    for (const el of allRows()) el.tabIndex = el === row ? ROVING_STOP : OUT_OF_TAB_ORDER;
  }

  function focusRow(row, actionIndex = ON_ROW) {
    makeStop(row);
    (actionsOf(row)[actionIndex] ?? row).focus();
  }

  function onRowFocus(e) {
    const row = rowOf(e.target);
    if (row && row.tabIndex !== ROVING_STOP) makeStop(row);
  }

  function moveBetweenRows(e, row) {
    const rows = shownRows();
    const next = rowStep(e.key, rows.indexOf(row), rows.length);
    if (next === null) return false;
    focusRow(rows[next]);
    return true;
  }

  function moveWithinRow(e, row) {
    const actions = actionsOf(row);
    const next = actionStep(e.key, e.target === row ? ON_ROW : actions.indexOf(e.target), actions.length);
    if (next === null) return false;
    focusRow(row, next);
    return true;
  }

  function onRowKeydown(e) {
    if (e.defaultPrevented || hasModifier(e)) return;
    const row = rowOf(e.target);
    if (!row || e.target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (e.target === row && e.key === ROW_KEY.OPEN) {
      e.preventDefault();
      openRow(row);
      return;
    }
    if (moveBetweenRows(e, row) || moveWithinRow(e, row)) e.preventDefault();
  }

  container.addEventListener("focusin", onRowFocus);
  container.addEventListener("keydown", onRowKeydown);

  function remember() {
    const active = document.activeElement;
    const row = rowOf(active) ?? container.querySelector(`:is(${rowSelector})[tabindex="${ROVING_STOP}"]`);
    if (!row) return null;
    return {
      key: keyOf(row),
      index: shownRows().indexOf(row),
      actionIndex: row === active ? ON_ROW : actionsOf(row).indexOf(active),
      hadFocus: Boolean(rowOf(active)),
    };
  }

  // A list drawn while its panel is hidden still needs a stop for when it is shown.
  function restore(saved) {
    for (const el of container.querySelectorAll(actionSelector)) el.tabIndex = OUT_OF_TAB_ORDER;
    const shown = shownRows();
    const rows = shown.length ? shown : allRows();
    const at = landingIndex(rows.map(keyOf), saved);
    const row = at === null ? preferredRow(rows) ?? rows[0] : rows[at];
    if (!row) return;
    if (saved?.hadFocus) focusRow(row, keyOf(row) === saved.key ? saved.actionIndex : ON_ROW);
    else makeStop(row);
  }

  function refresh() {
    restore(remember());
  }

  return { remember, restore, refresh };
}
