// Library sort (#235): the columns a person can sort by, read through one field map.

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
export const KEY_MODES = Object.freeze({ MAJOR: "major", MINOR: "minor" });

export const SORT_LABEL_KEYS = Object.freeze({
  [SORT_KEYS.ADDED]: "libSort.added",
  [SORT_KEYS.TITLE]: "libSort.title",
  [SORT_KEYS.ARTIST]: "libSort.artist",
  [SORT_KEYS.LENGTH]: "libSort.length",
  [SORT_KEYS.TEMPO]: "inspector.tempo",
  [SORT_KEYS.KEY]: "meta.key",
  [SORT_KEYS.MY_ORDER]: "libSort.myOrder",
});

const NATURAL_PITCHES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTALS = { "": 0, "#": 1, "♯": 1, b: -1, "♭": -1 };
const PITCH_CLASSES = 12;
const TONIC = /^([A-G])([#♯b♭]?)$/;
const MAJOR_WORD = /^maj/i;
const MINOR_WORD = /^min|minor/i;
const COLLATOR = new Intl.Collator(undefined, { sensitivity: "accent", numeric: true });

const positive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const name = (value) => text(typeof value === "string" ? value : value?.name);

/** How each song field is read, the one place to change when the song shape does. */
export const SONG_FIELDS = Object.freeze({
  id: (song) => song.id,
  added: (song) => positive(song.createdAt ?? song.created_at),
  title: (song) => text(song.userTitle) ?? text(song.title),
  artist: (song) => text(song.userArtist) ?? name(song.artist) ?? text(song.displayArtist),
  length: (song) => positive(song.duration),
  tempo: (song) => positive(song.bpm),
  key: (song) => text(song.key),
  scale: (song) => text(song.scale),
});

function modeOf(suffix, scale) {
  if (MAJOR_WORD.test(suffix)) return KEY_MODES.MAJOR;
  if (MINOR_WORD.test(suffix)) return KEY_MODES.MINOR;
  if (MINOR_WORD.test(scale)) return KEY_MODES.MINOR;
  return MAJOR_WORD.test(scale) ? KEY_MODES.MAJOR : null;
}

/** A song's key as { pitch: 0..11 from C, mode }, or null when it has none or it cannot be read. */
export function songKey(song) {
  const [tonic = "", suffix = ""] = (SONG_FIELDS.key(song) ?? "").split(/\s+/);
  const match = TONIC.exec(tonic);
  const mode = modeOf(suffix, SONG_FIELDS.scale(song) ?? "");
  if (!match || !mode) return null;
  const pitch = (NATURAL_PITCHES[match[1]] + ACCIDENTALS[match[2]] + PITCH_CLASSES) % PITCH_CLASSES;
  return { pitch, mode };
}

function keyRank(song) {
  const key = songKey(song);
  if (!key) return null;
  return key.pitch * 2 + (key.mode === KEY_MODES.MINOR ? 1 : 0);
}

const SORT_VALUES = {
  [SORT_KEYS.ADDED]: SONG_FIELDS.added,
  [SORT_KEYS.TITLE]: SONG_FIELDS.title,
  [SORT_KEYS.ARTIST]: SONG_FIELDS.artist,
  [SORT_KEYS.LENGTH]: SONG_FIELDS.length,
  [SORT_KEYS.TEMPO]: SONG_FIELDS.tempo,
  [SORT_KEYS.KEY]: keyRank,
};

export function newestFirst(a, b) {
  return (SONG_FIELDS.added(b) ?? 0) - (SONG_FIELDS.added(a) ?? 0);
}

function compareValues(a, b) {
  return typeof a === "string" ? COLLATOR.compare(a, b) : a - b;
}

function compareEntries(a, b, sign) {
  const missing = (a.value === null) - (b.value === null);
  if (missing || a.value === null) return missing || newestFirst(a.song, b.song);
  return sign * compareValues(a.value, b.value) || newestFirst(a.song, b.song);
}

/** Songs not in `ids` first, newest first, then the listed ones in list order; unknown ids drop out. */
export function applyMyOrder(songs, ids) {
  const position = new Map();
  ids.forEach((id, index) => position.has(id) || position.set(id, index));
  const unlisted = songs.filter((song) => !position.has(SONG_FIELDS.id(song))).sort(newestFirst);
  const listed = songs
    .filter((song) => position.has(SONG_FIELDS.id(song)))
    .sort((a, b) => position.get(SONG_FIELDS.id(a)) - position.get(SONG_FIELDS.id(b)));
  return [...unlisted, ...listed];
}

/** A new array in the chosen order; songs without the sorted value go last either way. */
export function sortSongs(songs, { sort, dir } = DEFAULT_SORT, myOrderIds = []) {
  if (sort === SORT_KEYS.MY_ORDER) return applyMyOrder(songs, myOrderIds);
  const valueOf = SORT_VALUES[sort] ?? SORT_VALUES[DEFAULT_SORT.sort];
  const sign = dir === DIRECTIONS.ASC ? 1 : -1;
  return songs
    .map((song) => ({ song, value: valueOf(song) }))
    .sort((a, b) => compareEntries(a, b, sign))
    .map((entry) => entry.song);
}

/** A column header click: the same column flips; another starts ascending, Recently added newest first. */
export function nextSortOnHeader(current, key) {
  if (current.sort === key) {
    return { sort: key, dir: current.dir === DIRECTIONS.ASC ? DIRECTIONS.DESC : DIRECTIONS.ASC };
  }
  return { sort: key, dir: key === SORT_KEYS.ADDED ? DIRECTIONS.DESC : DIRECTIONS.ASC };
}
