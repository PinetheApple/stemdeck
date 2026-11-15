// A click opens a song over the one playing, which keeps playing until
// Play starts the open one. Double-click, Enter and a row's Play open and play.

import { test, expect } from "@playwright/test";
import { ROW_KEY, ROW_PLAY_CLASS, SELECTED_ROW_CLASS } from "../../static/js/rovingRows.js";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  openStudio,
} from "./helpers.mjs";
import {
  LOAD_TIMEOUT_MS,
  SETTLE_MS,
  countOpens,
  expectPlaying,
  isPlaying,
  openSiblingOverPlaying,
  playingId,
  position,
  songRow,
  startPlayback,
} from "./openVsPlaying.mjs";

const PLAY = `.${ROW_PLAY_CLASS}`;
const SELECTED = new RegExp(`\\b${SELECTED_ROW_CLASS}\\b`);
const ACTIVE = /\bactive\b/;
const PREVIEW_ROW = "#openPreview .open-preview-row";
const FIXTURE_LANES = 4;
const SIBLING_LENGTH = "00:02";
// A's fixture is 6 s long; a start this close to its end reaches it within a test.
const NEAR_THE_END_SEC = 5;
const END_TIMEOUT_MS = 15000;
const START_SEC = 0;
const SPACE = "Space";
const NO_OPENS = 0;

const mediaTitle = (page) => page.evaluate(() => navigator.mediaSession?.metadata?.title ?? null);

async function seekNearTheEnd(page) {
  await page.evaluate(async (sec) => (await import("/js/transport.js")).setPlayheadTime(sec), NEAR_THE_END_SEC);
}

test.describe("a click opens a song over the one playing", () => {
  test("the playing song keeps playing while the clicked one's head, details and lanes show", async ({ page }) => {
    await openStudio(page);
    await startPlayback(page);
    const before = await position(page);

    await songRow(page, SIBLING_JOB_ID).click();

    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
    await expect(page.locator("#summary-duration")).toHaveText(SIBLING_LENGTH);
    await expect(page.locator(PREVIEW_ROW)).toHaveCount(FIXTURE_LANES);
    await expect(page.locator("#openPreview")).toBeVisible();
    expect(await playingId(page)).toBe(JOB_ID);
    expect(await isPlaying(page)).toBe(true);
    await expect.poll(() => position(page)).toBeGreaterThan(before);
    await expect.poll(() => mediaTitle(page)).toBe(TRACK_TITLE);
  });

  test("the playing song wears the coral fill, the open one the frame, and the footer names the playing one", async ({ page }) => {
    await openSiblingOverPlaying(page);
    await expect(songRow(page, JOB_ID)).toHaveClass(ACTIVE);
    await expect(songRow(page, JOB_ID)).not.toHaveClass(SELECTED);
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(SELECTED);
    await expect(songRow(page, SIBLING_JOB_ID)).not.toHaveClass(ACTIVE);
    await expect(page.locator("#footerPlaying")).toBeVisible();
    await expect(page.locator("#footerPlayingTitle")).toHaveText(TRACK_TITLE);
  });

  test("a click back on the playing song closes the open one without reloading", async ({ page }) => {
    await openSiblingOverPlaying(page);
    const opens = countOpens(page, JOB_ID);
    await songRow(page, JOB_ID).click();
    await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
    await expect(page.locator("#openPreview")).toBeHidden();
    await page.waitForTimeout(SETTLE_MS);
    expect(opens.count).toBe(NO_OPENS);
    expect(await playingId(page)).toBe(JOB_ID);
    expect(await isPlaying(page)).toBe(true);
  });

  test("Space pauses the playing song, and the next Play starts the open one", async ({ page }) => {
    await openSiblingOverPlaying(page);
    await page.keyboard.press(SPACE);
    await expect.poll(() => isPlaying(page)).toBe(false);
    expect(await playingId(page)).toBe(JOB_ID);
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);

    await page.locator("#t-play").click();
    await expectPlaying(page, SIBLING_JOB_ID);
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(ACTIVE);
    await expect(page.locator("#openPreview")).toBeHidden();
  });

  test("the song head's Play switches to the open song at once", async ({ page }) => {
    await openSiblingOverPlaying(page);
    await page.locator("#songPlayBtn").click();
    await expectPlaying(page, SIBLING_JOB_ID);
    await expect(page.locator("#songPlayBtn")).toBeHidden();
  });

  test("Stage mode shows the playing song", async ({ page }) => {
    await openSiblingOverPlaying(page);
    await page.locator("#stageModeBtn").click();
    await expect(page.locator("#stageTitle")).toHaveText(TRACK_TITLE);
  });
});

test.describe("opening and playing", () => {
  test("a row's Play opens the song and plays it", async ({ page }) => {
    await openStudio(page);
    const row = songRow(page, SIBLING_JOB_ID);
    await row.hover();
    await row.locator(PLAY).click();
    await expectPlaying(page, SIBLING_JOB_ID);
  });

  test("a double-click opens the song and plays it", async ({ page }) => {
    await openStudio(page);
    await songRow(page, SIBLING_JOB_ID).dblclick();
    await expectPlaying(page, SIBLING_JOB_ID);
  });

  test("a double-click while another song plays switches to it and plays it", async ({ page }) => {
    await openStudio(page);
    await startPlayback(page);
    await songRow(page, SIBLING_JOB_ID).dblclick();
    await expectPlaying(page, SIBLING_JOB_ID);
    await expect(page.locator("#openPreview")).toBeHidden();
  });

  test("Enter opens the selected song and plays it", async ({ page }) => {
    await openStudio(page);
    await songRow(page, JOB_ID).focus();
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press(ROW_KEY.OPEN);
    await expectPlaying(page, SIBLING_JOB_ID);
  });

  test("with nothing playing, a click opens the song paused", async ({ page }) => {
    await openStudio(page);
    await songRow(page, SIBLING_JOB_ID).click();
    await expect.poll(() => playingId(page), { timeout: LOAD_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(ACTIVE);
    await expect(page.locator("#openPreview")).toBeHidden();
    await page.waitForTimeout(SETTLE_MS);
    expect(await isPlaying(page)).toBe(false);
  });
});

test.describe("when the playing song ends", () => {
  test("with Up Next empty, the open song loads paused at the start", async ({ page }) => {
    await openStudio(page);
    await startPlayback(page);
    await seekNearTheEnd(page);
    await songRow(page, SIBLING_JOB_ID).click();
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
    await expect.poll(() => playingId(page), { timeout: END_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
    await expect(page.locator("#openPreview")).toBeHidden();
    await page.waitForTimeout(SETTLE_MS);
    expect(await isPlaying(page)).toBe(false);
    expect(await position(page)).toBe(START_SEC);
  });

  test("with a song in Up Next, Up Next plays it as before and the shown song goes", async ({ page }) => {
    await openStudio(page);
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent("upnext:add", { detail: { id } })), JOB_ID);
    await startPlayback(page);
    await seekNearTheEnd(page);
    await songRow(page, SIBLING_JOB_ID).click();
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
    await expect(page.locator("#title")).toHaveText(TRACK_TITLE, { timeout: END_TIMEOUT_MS });
    await expectPlaying(page, JOB_ID);
    await expect(page.locator("#openPreview")).toBeHidden();
  });
});
