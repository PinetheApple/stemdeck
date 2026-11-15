// Shared set-up for the Sing along specs: lyrics served for the fixture, Up Next seeded,
// and Stage opened in Sing along.

import { expect } from "@playwright/test";
import { JOB_ID } from "./helpers.mjs";

export const FIXTURE_SECONDS = 6;
export const LYRICS = {
  v: 1,
  source: "lrclib",
  track: "Fixture Song",
  artist: "Fixture Band",
  album: "",
  duration: FIXTURE_SECONDS,
  synced: "[00:02.00] Hold the line until the morning\n[00:04.00] Every word a little closer",
  plain: "",
  instrumental: false,
  lrclib_id: 1,
  others: [],
};
export const UP_NEXT_KEY = "stemdeck.upNext";
export const SONG_OPEN_TIMEOUT_MS = 20000;
const LYRICS_LOOKUP = /\/api\/jobs\/[a-f0-9]{12}\/lyrics\/lookup$/;
const NOT_FOUND = { status: 404, json: { detail: "no lyrics" } };

export const call = (page, module, name, ...args) => page.evaluate(
  async ([path, fn, callArgs]) => (await import(path))[fn](...callArgs),
  [module, name, args],
);
export const silenced = (page, stem) => call(page, "/js/mixer.js", "isLaneSilenced", stem);
export const openSongId = (page) => page.evaluate(
  async () => (await import("/js/catalog.js")).getCurrentTrackInfo()?.id,
);
export const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);

/** Serves `lyrics` for every song, or none with null. */
export async function serveLyrics(page, lyrics = LYRICS) {
  const answer = lyrics ? { status: 200, json: lyrics } : NOT_FOUND;
  await page.route("**/api/jobs/*/lyrics", (route) => route.fulfill(answer));
  await page.route(LYRICS_LOOKUP, (route) => route.fulfill(NOT_FOUND));
}

export async function seedUpNext(page, ids) {
  await page.addInitScript(([key, queued]) => localStorage.setItem(key, JSON.stringify(queued)), [UP_NEXT_KEY, ids]);
}

export async function enterSingAlong(page) {
  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageView")).toBeVisible();
  await page.locator("#stageLookSing").click();
  await expect(page.locator("#stageView")).toHaveClass(/\bsing\b/);
}

export async function seekTo(page, seconds) {
  await page.evaluate(async (at) => (await import("/js/transport.js")).setPlayheadTime(at), seconds);
}

export const endSong = (page, id = JOB_ID) => page.evaluate(
  (ended) => document.dispatchEvent(new CustomEvent("trackended", { detail: { id: ended } })),
  id,
);

/** Rewrites the job state the studio reads when `id` opens. */
export async function rewriteJobState(page, id, rewrite) {
  await page.route(`**/api/jobs/${id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: rewrite(await response.json()) });
  });
}
