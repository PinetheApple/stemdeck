// Picking several library or Trash songs to change them together (#235).

export const SELECTION_SCOPES = Object.freeze({ LIBRARY: "library", TRASH: "trash" });

export const BULK_ACTION = Object.freeze({
  UP_NEXT: "upNext",
  ADD_TO_SETLIST: "addToSetlist",
  MOVE_TO_FOLDER: "moveToFolder",
  FAVORITE: "favorite",
  TRASH: "trash",
  RESTORE: "restore",
});

export const BULK_ACTIONS = Object.freeze({
  [SELECTION_SCOPES.LIBRARY]: Object.freeze([
    BULK_ACTION.UP_NEXT,
    BULK_ACTION.ADD_TO_SETLIST,
    BULK_ACTION.MOVE_TO_FOLDER,
    BULK_ACTION.FAVORITE,
    BULK_ACTION.TRASH,
  ]),
  [SELECTION_SCOPES.TRASH]: Object.freeze([BULK_ACTION.RESTORE]),
});

export const BULK_ACTION_LABEL_KEYS = Object.freeze({
  [BULK_ACTION.UP_NEXT]: "inspector.upNext",
  [BULK_ACTION.ADD_TO_SETLIST]: "trackMenu.addToSetlist",
  [BULK_ACTION.MOVE_TO_FOLDER]: "trackMenu.moveToFolder",
  [BULK_ACTION.FAVORITE]: "libSort.favorite",
  [BULK_ACTION.TRASH]: "libSort.trash",
  [BULK_ACTION.RESTORE]: "libSort.restore",
});

function toggleIn(state, id) {
  if (state.picked.has(id)) state.picked.delete(id);
  else state.picked.add(id);
  state.anchor = id;
}

function pickRange(state, id, visibleIds, keepPicks) {
  const from = visibleIds.indexOf(state.anchor);
  const to = visibleIds.indexOf(id);
  if (from < 0 || to < 0) return toggleIn(state, id);
  if (!keepPicks) state.picked.clear();
  for (const rangeId of visibleIds.slice(Math.min(from, to), Math.max(from, to) + 1)) state.picked.add(rangeId);
}

function pruneTo(state, visibleIds) {
  const shown = new Set(visibleIds);
  state.picked = new Set([...state.picked].filter((id) => shown.has(id)));
  if (!shown.has(state.anchor)) state.anchor = null;
}

function reset(state, picking) {
  state.picking = picking;
  state.picked = new Set();
  state.anchor = null;
}

/**
 * Picks in the order they were made. While picking a plain click toggles; Ctrl/Cmd toggles and Shift
 * picks the range from the last click, either starting picking. Returns false for a click it leaves alone.
 */
export function createSelection() {
  const state = { picking: false, picked: new Set(), anchor: null };
  return {
    get picking() { return state.picking; },
    start: () => reset(state, true),
    done: () => reset(state, false),
    toggle: (id) => toggleIn(state, id),
    click(id, { shift = false, ctrl = false } = {}, visibleIds = []) {
      if (!state.picking && !shift && !ctrl) return false;
      state.picking = true;
      if (shift) pickRange(state, id, visibleIds, ctrl);
      else toggleIn(state, id);
      return true;
    },
    selectAll: (visibleIds) => { state.picked = new Set(visibleIds); },
    prune: (visibleIds) => pruneTo(state, visibleIds),
    has: (id) => state.picked.has(id),
    ids: () => [...state.picked],
    count: () => state.picked.size,
  };
}
