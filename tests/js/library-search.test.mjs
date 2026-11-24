// Browse library search: title, artist, source, stems and tags; #tag keeps to tags.
//
// Run:  node tests/js/library-search.test.mjs

import { chipTags, libraryTags, songMatches, toggleTagQuery } from "../../static/js/librarySearch.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) passed++;
  else failed++;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? "" : `  -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

const SONG = {
  title: "Blue Monday",
  artist: "New Order",
  source: "https://www.youtube.com/watch?v=abc",
  stems: ["vocals", "drums"],
  tags: ["rock", "80s"],
};
const TAGGED_TITLE = { ...SONG, title: "Rock Lobster", tags: ["party"] };

check("an empty query matches every song", songMatches(SONG, ""), true);
check("a blank query matches every song", songMatches(SONG, "   "), true);
check("matches the title, ignoring case", songMatches(SONG, "blue MON"), true);
check("matches the artist", songMatches(SONG, "new order"), true);
check("matches the source", songMatches(SONG, "youtube"), true);
check("matches a stem name", songMatches(SONG, "drums"), true);
check("matches a tag", songMatches(SONG, "80s"), true);
check("a word in none of them does not match", songMatches(SONG, "jazz"), false);
check("#rock matches the tag", songMatches(SONG, "#rock"), true);
check("#rock ignores a title that says rock", songMatches(TAGGED_TITLE, "#rock"), false);
check("#rock ignores the artist and source", songMatches({ ...SONG, tags: [] }, "#new"), false);
check("a bare # matches every song", songMatches(SONG, "#"), true);
check("a song with no fields matches only an empty query", songMatches({}, "a"), false);

const LIBRARY = [
  { tags: ["rock", "80s"] },
  { tags: ["rock", "live"] },
  { tags: [] },
  { tags: ["a", "b", "c", "d", "e", "f", "g"] },
];
check("library tags are unique, in library order", libraryTags(LIBRARY.slice(0, 3), 8), ["rock", "80s", "live"]);
check("library tags stop at the limit", libraryTags(LIBRARY, 8).length, 8);

check("the open song's tags lead, then the library's others", chipTags(["live", "jazz"], LIBRARY.slice(0, 3), 8), ["live", "jazz", "rock", "80s"]);
check("the open song's tags are listed once", chipTags(["jazz", "jazz"], [], 8), ["jazz"]);
check("the cap applies to the library's part only", chipTags(["x", "y"], LIBRARY, 8).length, 10);
check("with no open song, the chips are the library's", chipTags([], LIBRARY, 8), libraryTags(LIBRARY, 8));

check("a chip turns its tag on", toggleTagQuery("", "rock"), "#rock");
check("the same chip turns it off", toggleTagQuery("#rock", "rock"), "");
check("another chip replaces the query", toggleTagQuery("blue", "rock"), "#rock");

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
