// My order (#235): the library order a person dragged, kept on the server.

import { fetchJson } from "./libraryControls.js";

export { applyMyOrder } from "./librarySort.js";

export const MY_ORDER_URL = "/api/library/order";

let lastSave = Promise.resolve();

export async function loadMyOrder() {
  const { song_ids: ids } = await fetchJson(MY_ORDER_URL);
  return ids;
}

/** Saves wait for the one before, so the last order sent is the one kept; a failed save rejects. */
export function saveMyOrder(ids) {
  const send = () => fetchJson(MY_ORDER_URL, { method: "PUT", body: { song_ids: ids } });
  const save = lastSave.then(send, send).then((answer) => answer.song_ids);
  lastSave = save;
  return save;
}

/** `movedIds` placed before `beforeId`, or at the end for null, keeping their order; a new array. */
export function moveBefore(orderIds, movedIds, beforeId) {
  const moving = new Set(movedIds);
  if (moving.has(beforeId)) return [...orderIds];
  const moved = orderIds.filter((id) => moving.has(id));
  const rest = orderIds.filter((id) => !moving.has(id));
  const at = rest.indexOf(beforeId);
  if (at < 0) return [...rest, ...moved];
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}
