import { KEY_MODES, SONG_FIELDS, newestFirst, songKey } from "./songFields.js";
import { applyMyOrder } from "./myOrder.js";

export const SORT_KEYS = Object.freeze({
  ADDED: "added",
  TITLE: "title",
  ARTIST: "artist",
  LENGTH: "length",
  TEMPO: "tempo",
  KEY: "key",
  MY_ORDER: "myOrder",
});
export const DIRECTIONS = Object.freeze({ ASC: "asc", DESC: "desc" });
export const DEFAULT_SORT = Object.freeze({ sort: SORT_KEYS.ADDED, dir: DIRECTIONS.DESC });

export const SORT_LABEL_KEYS = Object.freeze({
  [SORT_KEYS.ADDED]: "libSort.added",
  [SORT_KEYS.TITLE]: "libSort.title",
  [SORT_KEYS.ARTIST]: "rename.artistLabel",
  [SORT_KEYS.LENGTH]: "libSort.length",
  [SORT_KEYS.TEMPO]: "inspector.tempo",
  [SORT_KEYS.KEY]: "meta.key",
  [SORT_KEYS.MY_ORDER]: "libSort.myOrder",
});

const MODE_RANK = Object.freeze({ [KEY_MODES.MAJOR]: 0, [KEY_MODES.MINOR]: 1 });
const MODES_PER_PITCH = Object.keys(MODE_RANK).length;
const COLLATOR = new Intl.Collator(undefined, { sensitivity: "accent", numeric: true });

function keyRank(song) {
  const key = songKey(song);
  if (!key) return null;
  return key.pitch * MODES_PER_PITCH + MODE_RANK[key.mode];
}

const SORT_VALUES = {
  [SORT_KEYS.ADDED]: SONG_FIELDS.added,
  [SORT_KEYS.TITLE]: SONG_FIELDS.title,
  [SORT_KEYS.ARTIST]: SONG_FIELDS.artist,
  [SORT_KEYS.LENGTH]: SONG_FIELDS.length,
  [SORT_KEYS.TEMPO]: SONG_FIELDS.tempo,
  [SORT_KEYS.KEY]: keyRank,
};

function compareValues(a, b) {
  return typeof a === "string" ? COLLATOR.compare(a, b) : a - b;
}

function compareEntries(a, b, sign) {
  const missing = (a.value === null) - (b.value === null);
  if (missing || a.value === null) return missing || newestFirst(a.song, b.song);
  return sign * compareValues(a.value, b.value) || newestFirst(a.song, b.song);
}

export function sortSongs(songs, { sort, dir } = DEFAULT_SORT, myOrderIds = []) {
  if (sort === SORT_KEYS.MY_ORDER) return applyMyOrder(songs, myOrderIds);
  const valueOf = SORT_VALUES[sort] ?? SORT_VALUES[DEFAULT_SORT.sort];
  const sign = dir === DIRECTIONS.ASC ? 1 : -1;
  return songs
    .map((song) => ({ song, value: valueOf(song) }))
    .sort((a, b) => compareEntries(a, b, sign))
    .map((entry) => entry.song);
}

export function nextSortOnHeader(current, key) {
  if (current.sort === key) {
    return { sort: key, dir: current.dir === DIRECTIONS.ASC ? DIRECTIONS.DESC : DIRECTIONS.ASC };
  }
  return { sort: key, dir: key === SORT_KEYS.ADDED ? DIRECTIONS.DESC : DIRECTIONS.ASC };
}
