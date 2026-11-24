// The sidebar's Recently played: newest first, once each, trashed songs left out, capped.
//
// Run:  node tests/js/recently-played.test.mjs

import { RECENT_CAP, recentIds, withPlayed } from "../../static/js/recentlyPlayed.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) passed++;
  else failed++;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? "" : `  -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

check("the first play starts the list", withPlayed([], "a"), ["a"]);
check("the newest play comes first", withPlayed(["a", "b"], "c"), ["c", "a", "b"]);
check("playing a song again moves it up, once", withPlayed(["a", "b", "c"], "c"), ["c", "a", "b"]);
const full = Array.from({ length: RECENT_CAP }, (_, i) => `s${i}`);
check("the stored list is capped", withPlayed(full, "new").length, RECENT_CAP);
check("the oldest play drops off the end", withPlayed(full, "new").at(-1), `s${RECENT_CAP - 2}`);
check("an empty id is not a play", withPlayed(["a"], ""), ["a"]);

const listed = (id) => id !== "trashed";
check("trashed songs are left out", recentIds(["a", "trashed", "b"], { isListed: listed, limit: 4 }), ["a", "b"]);
check("the shown list stops at its limit", recentIds(["a", "b", "c", "d", "e"], { isListed: listed, limit: 4 }), ["a", "b", "c", "d"]);
check("duplicates read from storage show once", recentIds(["a", "a", "b"], { isListed: listed, limit: 4 }), ["a", "b"]);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
