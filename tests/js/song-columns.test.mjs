// The Browse library list's columns: Artist, Key, Tempo, Length, Folder and Added.
//
// Run:  node tests/js/song-columns.test.mjs

import { addedLabel, songCells } from "../../static/js/songColumns.js";

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (same) passed++;
  else failed++;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? "" : `  -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}

const DAY_S = 86400;
const NOW_MS = Date.UTC(2026, 10, 24, 15, 0, 0);
const NOW_S = NOW_MS / 1000;
const WORDS = {
  today: "Today",
  yesterday: "Yesterday",
  daysAgo: (n) => `${n} days ago`,
  dated: (ms) => new Date(ms).toISOString().slice(0, 10),
};

check("added an hour ago reads Today", addedLabel(NOW_S - 3600, NOW_MS, WORDS), "Today");
check("added a day ago reads Yesterday", addedLabel(NOW_S - DAY_S - 60, NOW_MS, WORDS), "Yesterday");
check("added three days ago reads 3 days ago", addedLabel(NOW_S - 3 * DAY_S - 60, NOW_MS, WORDS), "3 days ago");
check("29 days still counts days", addedLabel(NOW_S - 29 * DAY_S - 60, NOW_MS, WORDS), "29 days ago");
check("after 30 days it shows the date", addedLabel(NOW_S - 31 * DAY_S, NOW_MS, WORDS), "2026-10-24");
check("no date added reads nothing", addedLabel(undefined, NOW_MS, WORDS), "");

const FORMAT = {
  now: NOW_MS,
  words: WORDS,
  artistName: "The Band",
  folderName: "Gig",
  keyLabel: (key, scale) => `${key} ${scale}`,
  time: (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`,
};
const DONE = { status: "done", key: "B", scale: "minor", bpm: 119.6, duration: 245, createdAt: NOW_S - 3600 };

check(
  "a finished song fills every cell",
  songCells(DONE, FORMAT),
  { artist: "The Band", key: "B minor", tempo: "120", length: "4:05", folder: "Gig", added: "Today" },
);
check("an unknown tempo and key stay blank", songCells({ ...DONE, bpm: null, key: null }, FORMAT).tempo + songCells({ ...DONE, key: null }, FORMAT).key, "");
check(
  "an unfinished song leaves every cell blank",
  songCells({ ...DONE, status: "separating" }, FORMAT),
  { artist: "", key: "", tempo: "", length: "", folder: "", added: "" },
);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
