// The songs played most recently, newest first, kept on this device. Fed by
// the player's play state; the sidebar's Recently played reads it.

export const RECENT_CAP = 50;
export const STORAGE_KEY = "stemdeck.recentlyPlayed";
const listeners = new Set();

/** `ids` with `id` played now: first, once, the list capped. */
export function withPlayed(ids, id, cap = RECENT_CAP) {
  if (!id) return ids;
  return [id, ...ids.filter((other) => other !== id)].slice(0, cap);
}

/** The ids still listed (`isListed`), each once, at most `limit`. */
export function recentIds(ids, { isListed, limit }) {
  return [...new Set(ids)].filter(isListed).slice(0, limit);
}

export function readRecentlyPlayed() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch (err) {
    console.warn("[recentlyPlayed] unreadable list:", err);
    return [];
  }
}

export function recordPlayed(id) {
  const next = withPlayed(readRecentlyPlayed(), id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[recentlyPlayed] could not save:", err);
  }
  for (const listener of listeners) listener(next);
}

export function onRecentlyPlayedChange(listener) {
  listeners.add(listener);
}
