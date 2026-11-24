import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SORT,
  DIRECTIONS,
  SORT_KEYS,
  nextSortOnHeader,
  sortSongs,
} from "../../static/js/librarySort.js";
import { SONG_FIELDS } from "../../static/js/songFields.js";

const { ASC, DESC } = DIRECTIONS;
const banana = { id: "a", title: "Banana", artist: { name: "Zed" }, duration: 200, bpm: 120, key: "D maj", createdAt: 3 };
const apple = { id: "b", title: "apple", artist: { name: "alice" }, duration: 100, bpm: 80, key: "C min", createdAt: 2 };
const cherry = { id: "c", title: "cherry", artist: { name: "Bob" }, duration: 300, bpm: 140, key: "C maj", createdAt: 1 };
const unfinished = { id: "d", title: "", duration: 0, bpm: null, key: null, createdAt: 4 };
const SONGS = [banana, apple, cherry, unfinished];

const ASCENDING_IDS = {
  [SORT_KEYS.ADDED]: ["c", "b", "a", "d"],
  [SORT_KEYS.TITLE]: ["b", "a", "c"],
  [SORT_KEYS.ARTIST]: ["b", "c", "a"],
  [SORT_KEYS.LENGTH]: ["b", "a", "c"],
  [SORT_KEYS.TEMPO]: ["b", "a", "c"],
  [SORT_KEYS.KEY]: ["c", "b", "a"],
};
const MISSING_ID = "d";

const ids = (songs) => songs.map((song) => song.id);
const sorted = (sort, dir, songs = SONGS) => ids(sortSongs(songs, { sort, dir }));

test("every column sorts ascending, songs without the value last", () => {
  for (const [sort, expected] of Object.entries(ASCENDING_IDS)) {
    const tail = expected.includes(MISSING_ID) ? [] : [MISSING_ID];
    assert.deepEqual(sorted(sort, ASC), [...expected, ...tail], sort);
  }
});

test("every column sorts descending, songs without the value still last", () => {
  for (const [sort, expected] of Object.entries(ASCENDING_IDS)) {
    const present = expected.filter((id) => id !== MISSING_ID).reverse();
    const descending = expected.includes(MISSING_ID) ? [MISSING_ID, ...present] : [...present, MISSING_ID];
    assert.deepEqual(sorted(sort, DESC), descending, sort);
  }
});

test("the default is newest added first", () => {
  assert.deepEqual(DEFAULT_SORT, { sort: SORT_KEYS.ADDED, dir: DESC });
  assert.deepEqual(ids(sortSongs(SONGS, DEFAULT_SORT)), ["d", "a", "b", "c"]);
});

test("ties go newest added first in both directions", () => {
  const older = { id: "old", bpm: 100, createdAt: 1 };
  const newer = { id: "new", bpm: 100, createdAt: 2 };
  assert.deepEqual(sorted(SORT_KEYS.TEMPO, ASC, [older, newer]), ["new", "old"]);
  assert.deepEqual(sorted(SORT_KEYS.TEMPO, DESC, [older, newer]), ["new", "old"]);
});

test("keys sort by pitch class, major before minor, flats as their sharps", () => {
  const songs = [
    { id: "dbMin", key: "Db min", createdAt: 1 },
    { id: "cSharpMaj", key: "C# maj", createdAt: 2 },
    { id: "bHarmonic", key: "B min", scale: "Harmonic Minor", createdAt: 3 },
    { id: "unreadable", key: "weird", createdAt: 4 },
  ];
  assert.deepEqual(sorted(SORT_KEYS.KEY, ASC, songs), ["cSharpMaj", "dbMin", "bHarmonic", "unreadable"]);
});

test("titles and artists sort without regard to case", () => {
  assert.deepEqual(sorted(SORT_KEYS.TITLE, ASC, [banana, apple]), ["b", "a"]);
  assert.deepEqual(sorted(SORT_KEYS.ARTIST, ASC, [cherry, apple]), ["b", "c"]);
});

test("names a person gave a song come first", () => {
  const renamed = { title: "upload.mp3", userTitle: "My song", artist: { name: "X" }, userArtist: "Me" };
  assert.equal(SONG_FIELDS.title(renamed), "My song");
  assert.equal(SONG_FIELDS.artist(renamed), "Me");
});

const work = { id: "Q1", kind: "musical", name: "Hamilton" };

test("the artist is the soundtrack's show, unless it repeats the song's name", () => {
  const band = { name: "Cast" };
  assert.equal(SONG_FIELDS.artist({ title: "My Shot", work, artist: band }), "Hamilton");
  assert.equal(SONG_FIELDS.artist({ title: "hamilton", work, artist: band }), "Cast");
  assert.equal(SONG_FIELDS.artist({ title: "x", identity: { source: "musicbrainz", title: "Hamilton" }, work, artist: band }), "Cast");
  assert.equal(SONG_FIELDS.artist({ title: "x", displayArtist: "Uploader" }), "Uploader");
});

test("a work the library would not show is not the artist", () => {
  const band = { name: "Cast" };
  assert.equal(SONG_FIELDS.artist({ title: "x", work: { ...work, kind: "album" }, artist: band }), "Cast");
  assert.equal(SONG_FIELDS.artist({ title: "x", work: { ...work, id: "" }, artist: band }), "Cast");
});

test("My order follows the saved ids and ignores the direction", () => {
  const order = ["c", "a"];
  const expected = ["d", "b", "c", "a"];
  assert.deepEqual(ids(sortSongs(SONGS, { sort: SORT_KEYS.MY_ORDER, dir: ASC }, order)), expected);
  assert.deepEqual(ids(sortSongs(SONGS, { sort: SORT_KEYS.MY_ORDER, dir: DESC }, order)), expected);
});

test("sorting returns a new array and leaves the library alone", () => {
  const before = [...SONGS];
  const result = sortSongs(SONGS, { sort: SORT_KEYS.TITLE, dir: ASC });
  assert.notEqual(result, SONGS);
  assert.deepEqual(SONGS, before);
});

test("a header click flips its own column and starts another ascending", () => {
  const byTitle = { sort: SORT_KEYS.TITLE, dir: ASC };
  assert.deepEqual(nextSortOnHeader(byTitle, SORT_KEYS.TITLE), { sort: SORT_KEYS.TITLE, dir: DESC });
  assert.deepEqual(nextSortOnHeader({ ...byTitle, dir: DESC }, SORT_KEYS.TITLE), byTitle);
  assert.deepEqual(nextSortOnHeader(byTitle, SORT_KEYS.TEMPO), { sort: SORT_KEYS.TEMPO, dir: ASC });
});

test("the added header starts newest first", () => {
  const byTitle = { sort: SORT_KEYS.TITLE, dir: ASC };
  assert.deepEqual(nextSortOnHeader(byTitle, SORT_KEYS.ADDED), { sort: SORT_KEYS.ADDED, dir: DESC });
});
