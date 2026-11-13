// Which file format a stem URL points at. A song stored as MP3 serves its stems
// from `.mp3` URLs; the chunked engine only reads WAV, and downloads must be
// named after the real format.
//
// Run:  node tests/js/stem-file-ext.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { hasCompressedStems, stemFileExt } from "../../static/js/playbackStems.js";

const WAV_URL = "/api/jobs/abc123/stems/vocals.wav";
const MP3_URL = "/api/jobs/abc123/stems/vocals.mp3";

test("a .wav URL is WAV", () => {
  assert.equal(stemFileExt(WAV_URL), "wav");
});

test("a .mp3 URL is MP3", () => {
  assert.equal(stemFileExt(MP3_URL), "mp3");
});

test("a query string does not hide the extension", () => {
  assert.equal(stemFileExt(`${MP3_URL}?start=1&end=2`), "mp3");
});

test("a missing URL falls back to WAV", () => {
  assert.equal(stemFileExt(undefined), "wav");
  assert.equal(stemFileExt("#"), "wav");
});

test("a WAV song has no compressed stems", () => {
  const stems = [
    { name: "vocals", url: WAV_URL },
    { name: "drums", url: "/api/jobs/abc123/stems/drums.wav" },
  ];
  assert.equal(hasCompressedStems(stems), false);
});

test("one MP3 stem makes the set compressed", () => {
  const stems = [
    { name: "vocals", url: MP3_URL },
    { name: "drums", url: "/api/jobs/abc123/stems/drums.wav" },
  ];
  assert.equal(hasCompressedStems(stems), true);
});

test("an empty set is not compressed", () => {
  assert.equal(hasCompressedStems([]), false);
});
