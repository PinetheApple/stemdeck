// Shared set-up for the open-versus-playing specs: the fixture song A plays while
// its sibling B is shown over it.

import { expect } from "@playwright/test";
import { SIBLING_JOB_ID, SIBLING_TITLE, openStudio } from "./helpers.mjs";

export const SONG_ROW = "#catalogList .cat-item";
export const LOAD_TIMEOUT_MS = 20000;
export const SETTLE_MS = 600;

export const songRow = (page, id) => page.locator(`${SONG_ROW}[data-id="${id}"]`).first();
export const playingId = (page) => page.evaluate(async () => (await import("/js/state.js")).currentJobId);
export const isPlaying = (page) => page.evaluate(
  async () => (await import("/js/state.js")).audioEngine?.isPlaying() === true,
);
export const position = (page) => page.evaluate(
  async () => (await import("/js/state.js")).audioEngine?.getCurrentTime() ?? 0,
);
export const shownId = (page) => page.evaluate(async () => (await import("/js/catalog.js")).shownTrackId());

/** How many times the page starts opening a song: every open asks for its peaks first, once. */
export function countOpens(page, id) {
  const opens = { count: 0 };
  page.on("request", function onPeaksRead(req) {
    if (new URL(req.url()).pathname === `/api/jobs/${id}/peaks`) opens.count++;
  });
  return opens;
}

export async function startPlayback(page) {
  await page.locator("#t-play").click();
  await expect.poll(() => isPlaying(page)).toBe(true);
}

/** A plays and B is shown over it. */
export async function openSiblingOverPlaying(page) {
  await openStudio(page);
  await startPlayback(page);
  await songRow(page, SIBLING_JOB_ID).click();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
}

export async function expectPlaying(page, id) {
  await expect.poll(() => playingId(page), { timeout: LOAD_TIMEOUT_MS }).toBe(id);
  await expect.poll(() => isPlaying(page), { timeout: LOAD_TIMEOUT_MS }).toBe(true);
}
