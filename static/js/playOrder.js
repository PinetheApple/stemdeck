export const RESTART_AFTER_SEC = 3;
export const NEXT_SOURCE = Object.freeze({ HISTORY: "history", UP_NEXT: "upNext", LIST: "list" });
const NOT_IN_LIST = -1;

/** The song Previous goes to, or null when it restarts the playing one. */
export function previousSongId(positionSec, backId) {
  return positionSec > RESTART_AFTER_SEC ? null : backId;
}

export function nextSong({ forwardId, upNextId, listId }) {
  if (forwardId) return { source: NEXT_SOURCE.HISTORY, id: forwardId };
  if (upNextId) return { source: NEXT_SOURCE.UP_NEXT, id: upNextId };
  if (listId) return { source: NEXT_SOURCE.LIST, id: listId };
  return null;
}

export function songsAhead({ ids, at }, isAhead) {
  return ids.slice(at + 1).filter(isAhead);
}

export function cursorAt({ ids, at }, trackId) {
  const index = ids.indexOf(trackId);
  return index === NOT_IN_LIST ? at : index;
}
