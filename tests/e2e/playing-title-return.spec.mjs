// The footer's Playing title returns the studio to the playing song without touching playback.

import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, TRACK_TITLE } from "./helpers.mjs";
import {
  isPlaying,
  openSiblingOverPlaying,
  position,
  shownId,
  songRow,
} from "./openVsPlaying.mjs";

const PLAYING_TITLE = "#footerPlayingTitle";
const SHORT_WAIT_MS = 300;

async function expectClockAdvancing(page) {
  const before = await position(page);
  await expect.poll(() => position(page)).toBeGreaterThan(before);
  expect(await isPlaying(page)).toBe(true);
}

async function expectBackOnPlayingSong(page) {
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
  expect(await shownId(page)).toBeNull();
  await expect(songRow(page, JOB_ID)).toBeInViewport();
}

test("clicking the Playing title shows the playing song and keeps it playing", async ({ page }) => {
  await openSiblingOverPlaying(page);
  await page.locator(PLAYING_TITLE).click();
  await expectBackOnPlayingSong(page);
  await expectClockAdvancing(page);
  expect(await shownId(page)).not.toBe(SIBLING_JOB_ID);
});

test("Enter on the Playing title does the same", async ({ page }) => {
  await openSiblingOverPlaying(page);
  await page.locator(PLAYING_TITLE).focus();
  await page.waitForTimeout(SHORT_WAIT_MS);
  await page.keyboard.press("Enter");
  await expectBackOnPlayingSong(page);
  await expectClockAdvancing(page);
});
