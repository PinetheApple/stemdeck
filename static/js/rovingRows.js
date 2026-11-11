// One Tab stop per list (roving tabindex). Up/Down/Home/End move between rows, Enter
// opens one, Right/Left walk into and back out of the row's own buttons. In a list with
// selectable rows, the row holding focus is the selected one: a click selects, and a
// double-click or the row's Play button opens.

export const ROW_KEY = Object.freeze({
  PREVIOUS: "ArrowUp",
  NEXT: "ArrowDown",
  FIRST: "Home",
  LAST: "End",
  INTO: "ArrowRight",
  BACK: "ArrowLeft",
  OPEN: "Enter",
});

export const SELECTED_ROW_CLASS = "is-selected";
export const ROW_PLAY_CLASS = "row-play";

const ROVING_STOP = 0;
export const OUT_OF_TAB_ORDER = -1;
export const ON_ROW = -1;
const NOT_FOUND = -1;
const KEYBOARD_FOCUS = ":focus-visible";
const TEXT_FIELD = "input, textarea, select, [contenteditable='true']";
const NOT_THE_ROW = `button, form, ${TEXT_FIELD}`;
const SECOND_CLICK = 2;
const wiredLists = new WeakMap();

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
  const same = saved ? keys.indexOf(saved.key) : NOT_FOUND;
  if (same !== NOT_FOUND) return same;
  if (!saved || saved.index < 0) return null;
  return Math.min(saved.index, keys.length - 1);
}

/** Where focus sits in a row: ON_ROW, or the index of the action holding it. */
export function actionIndexOf(actions, el) {
  const at = actions.indexOf(el);
  return at === NOT_FOUND ? ON_ROW : at;
}

export function isShown(el) {
  return el.getClientRects().length > 0;
}

function hasModifier(e) {
  return e.altKey || e.ctrlKey || e.metaKey || e.shiftKey;
}

function wireRowSelection({ selectableRow, rowOf, allRows, keyOf }) {
  let selectedKey = null;
  const isSelectable = (row) => Boolean(selectableRow) && row.matches(selectableRow);

  function selectableRowOf(target) {
    const row = rowOf(target);
    return row && isSelectable(row) ? row : null;
  }

  function paintSelection() {
    if (!selectableRow) return;
    for (const el of allRows()) {
      el.classList.toggle(SELECTED_ROW_CLASS, isSelectable(el) && keyOf(el) === selectedKey);
    }
  }

  function select(row) {
    const key = keyOf(row);
    if (key === selectedKey) return;
    selectedKey = key;
    paintSelection();
  }

  return { select, paintSelection, selectableRowOf };
}

function wireRowOpening(container, { selectableRowOf, openRow, focusRow }) {
  function onRowDoubleClick(e) {
    const row = selectableRowOf(e.target);
    if (row && !e.target.closest(NOT_THE_ROW)) openRow(row);
  }

  // The double-click opens; without this it would also select the title's text.
  function onRowMousedown(e) {
    if (e.detail >= SECOND_CLICK && selectableRowOf(e.target) && !e.target.closest(TEXT_FIELD)) e.preventDefault();
  }

  function onRowPlayClick(e) {
    if (!e.target.closest(`.${ROW_PLAY_CLASS}`)) return;
    const row = selectableRowOf(e.target);
    if (!row) return;
    focusRow(row, ON_ROW, { preventScroll: true, focusVisible: false });
    openRow(row);
  }

  container.addEventListener("dblclick", onRowDoubleClick);
  container.addEventListener("mousedown", onRowMousedown);
  container.addEventListener("click", onRowPlayClick);
}

/**
 * Make `container` one Tab stop over the rows matching `rowSelector`.
 * `keyOf(row)` names a row across redraws; `openRow(row)` is what Enter does;
 * `preferredRow(rows)` picks the stop among `rows` when none was focused yet.
 * Rows matching `selectableRow` wear SELECTED_ROW_CLASS while they are the row
 * last focused, and open on a double-click or a click on their ROW_PLAY_CLASS button.
 * Call `remember()` before a redraw and `restore(saved)` after it, or `refresh()`
 * when rows were shown or hidden without one. `isKeyboardFocus()` says whether the
 * focus in the list is the keyboard's rather than a click's or a tap's.
 * `focusRow(row, actionIndex, options)` moves the list's stop and focus to `row`.
 * Wiring the same list again returns its first wiring.
 */
export function wireRovingRows(
  container,
  { rowSelector, actionSelector, keyOf, openRow, preferredRow = () => null, selectableRow = null },
) {
  if (wiredLists.has(container)) return wiredLists.get(container);
  // Read as focus arrives: a key pressed later can make a clicked row match too.
  let arrivedByKeyboard = false;

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

  function focusRow(row, actionIndex = ON_ROW, options = {}) {
    makeStop(row);
    (actionsOf(row)[actionIndex] ?? row).focus(options);
  }

  const { select, paintSelection, selectableRowOf } = wireRowSelection({ selectableRow, rowOf, allRows, keyOf });
  wireRowOpening(container, { selectableRowOf, openRow, focusRow });

  function onRowFocus(e) {
    arrivedByKeyboard = e.target.matches(KEYBOARD_FOCUS);
    const row = rowOf(e.target);
    if (!row) return;
    if (row.tabIndex !== ROVING_STOP) makeStop(row);
    select(row);
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
    const next = actionStep(e.key, actionIndexOf(actions, e.target), actions.length);
    if (next === null) return false;
    focusRow(row, next);
    return true;
  }

  function onRowKeydown(e) {
    if (e.defaultPrevented || hasModifier(e)) return;
    const row = rowOf(e.target);
    if (!row || e.target.closest(TEXT_FIELD)) return;
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
      actionIndex: actionIndexOf(actionsOf(row), active),
      hadFocus: Boolean(rowOf(active)),
      byKeyboard: Boolean(rowOf(active)) && arrivedByKeyboard,
    };
  }

  // A list drawn while its panel is hidden still needs a stop for when it is shown.
  function restore(saved) {
    for (const el of container.querySelectorAll(actionSelector)) el.tabIndex = OUT_OF_TAB_ORDER;
    const shown = shownRows();
    const rows = shown.length ? shown : allRows();
    const at = landingIndex(rows.map(keyOf), saved);
    const row = at === null ? preferredRow(rows) ?? rows[0] : rows[at];
    paintSelection();
    if (!row) return;
    if (!saved?.hadFocus) {
      makeStop(row);
      return;
    }
    focusRow(
      row,
      keyOf(row) === saved.key ? saved.actionIndex : ON_ROW,
      { preventScroll: true, focusVisible: saved.byKeyboard },
    );
    arrivedByKeyboard = saved.byKeyboard;
  }

  function refresh() {
    restore(remember());
  }

  function isKeyboardFocus() {
    return Boolean(rowOf(document.activeElement)) && arrivedByKeyboard;
  }

  const wired = { remember, restore, refresh, isKeyboardFocus, focusRow };
  wiredLists.set(container, wired);
  return wired;
}
