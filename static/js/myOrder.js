import { fetchJson } from "./libraryControls.js";
import { SONG_FIELDS, newestFirst } from "./songFields.js";

export const MY_ORDER_URL = "/api/library/order";
const SAVE_METHOD = "PUT";
const IDS_FIELD = "song_ids";

let lastSave = Promise.resolve();

export async function loadMyOrder() {
  const body = await fetchJson(MY_ORDER_URL);
  return body[IDS_FIELD];
}

// Chained so the last order sent is the one the server keeps.
export function saveMyOrder(ids) {
  const send = () => fetchJson(MY_ORDER_URL, { method: SAVE_METHOD, body: { [IDS_FIELD]: ids } });
  const save = lastSave.then(send, send).then((body) => body[IDS_FIELD]);
  lastSave = save;
  return save;
}

export function applyMyOrder(songs, ids) {
  const position = new Map();
  ids.forEach((id, index) => position.has(id) || position.set(id, index));
  const unlisted = songs.filter((song) => !position.has(SONG_FIELDS.id(song))).sort(newestFirst);
  const listed = songs
    .filter((song) => position.has(SONG_FIELDS.id(song)))
    .sort((a, b) => position.get(SONG_FIELDS.id(a)) - position.get(SONG_FIELDS.id(b)));
  return [...unlisted, ...listed];
}

export function moveBefore(orderIds, movedIds, beforeId) {
  const moving = new Set(movedIds);
  const rest = orderIds.filter((id) => !moving.has(id));
  const at = beforeId == null ? rest.length : rest.indexOf(beforeId);
  if (at < 0) return [...orderIds];
  const moved = orderIds.filter((id) => moving.has(id));
  return [...rest.slice(0, at), ...moved, ...rest.slice(at)];
}

// The server replaces the whole order, so a move made with filters on still
// has to send the songs the filters hide.
export function myOrderAfterMove(librarySongs, savedIds, movedIds, beforeId) {
  const wholeOrder = applyMyOrder(librarySongs, savedIds).map(SONG_FIELDS.id);
  return moveBefore(wholeOrder, movedIds, beforeId);
}
