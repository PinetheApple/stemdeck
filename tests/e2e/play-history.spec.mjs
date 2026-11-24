// Previous and Next follow what was played, Next goes on through the list a song
// was started from, and the song header steps Back and Forward through songs shown.

import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE, TRACK_TITLE, openBrowse, openInspectorTab, openStudio } from "./helpers.mjs";
import {
  LOAD_TIMEOUT_MS,
  SETTLE_MS,
  expectPlaying,
  isPlaying,
  openSiblingOverPlaying,
  playingId,
  position,
  shownId,
  songRow,
  startPlayback,
} from "./openVsPlaying.mjs";

const PAST_RESTART_SEC = 4;
const WITHIN_RESTART_SEC = 2;
const RESTART_SLACK_SEC = 0.5;
const SETLIST = "Gig";
const FROM_ROWS = "#upNextFromList .upnext-row";

test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const seek = (page, sec) => page.evaluate(async (at) => (await import("/js/transport.js")).setPlayheadTime(at), sec);

async function seekTo(page, sec) {
  await seek(page, sec);
  await expect.poll(() => position(page)).toBeGreaterThan(sec - RESTART_SLACK_SEC);
}

async function expectInPlayer(page, id) {
  await expect.poll(() => playingId(page), { timeout: LOAD_TIMEOUT_MS }).toBe(id);
}

/** The sibling (2 s) first, then the fixture: a setlist played from the top. */
async function playSetlist(page, request) {
  const res = await request.post("/api/setlists", { data: { name: SETLIST, song_ids: [SIBLING_JOB_ID, JOB_ID] } });
  const { id } = await res.json();
  await openStudio(page);
  await openBrowse(page, `setlist:${id}`);
  await page.locator("#browseResults .browse-setlist-play").click();
  await expectPlaying(page, SIBLING_JOB_ID);
  await openInspectorTab(page, "upnext");
}

test("Previous goes to the song played before it, and Next forward again", async ({ page }) => {
  await openStudio(page);
  await startPlayback(page);
  await songRow(page, SIBLING_JOB_ID).dblclick();
  await expectPlaying(page, SIBLING_JOB_ID);

  await page.locator("#t-prev").click();
  await expectInPlayer(page, JOB_ID);
  await expect(page.locator("#t-next")).toBeEnabled();
  await page.locator("#t-next").click();
  await expectInPlayer(page, SIBLING_JOB_ID);
});

test("Previous restarts a song played for more than 3 seconds, and steps back within them", async ({ page }) => {
  await openStudio(page);
  await songRow(page, SIBLING_JOB_ID).dblclick();
  await expectPlaying(page, SIBLING_JOB_ID);
  await songRow(page, JOB_ID).dblclick();
  await expectPlaying(page, JOB_ID);

  await seekTo(page, PAST_RESTART_SEC);
  await page.locator("#t-prev").click();
  await expect.poll(() => position(page)).toBeLessThan(RESTART_SLACK_SEC);
  expect(await playingId(page)).toBe(JOB_ID);

  await page.locator("#t-prev").click();
  await expectInPlayer(page, SIBLING_JOB_ID);
});

test("with only the playing song played before, Previous restarts it rather than going to a song only opened", async ({ page }) => {
  await openStudio(page);
  await startPlayback(page);
  await page.locator("#t-play").click();
  await expect.poll(() => isPlaying(page)).toBe(false);
  await songRow(page, SIBLING_JOB_ID).click();
  await expectInPlayer(page, SIBLING_JOB_ID);
  await songRow(page, JOB_ID).dblclick();
  await expectPlaying(page, JOB_ID);
  await seekTo(page, WITHIN_RESTART_SEC);

  await page.locator("#t-prev").click();
  await expect.poll(() => position(page)).toBeLessThan(RESTART_SLACK_SEC);
  expect(await playingId(page)).toBe(JOB_ID);
});

test("a setlist played from the top becomes the list Next follows, and nothing else starts by itself", async ({ page, request }) => {
  await playSetlist(page, request);
  await expect(page.locator("#upNextFromLabel")).toHaveText(`Next from: ${SETLIST}`);
  await expect(page.locator(FROM_ROWS)).toHaveCount(1);
  await expect(page.locator(FROM_ROWS)).toHaveAttribute("data-id", JOB_ID);
  await expect(page.locator("#upNextNothingQueued")).toBeVisible();
  await expect(page.locator("#upNextEmpty")).toBeHidden();

  await expect.poll(() => isPlaying(page), { timeout: LOAD_TIMEOUT_MS }).toBe(false);
  await page.waitForTimeout(SETTLE_MS);
  expect(await playingId(page)).toBe(SIBLING_JOB_ID);
  expect(await isPlaying(page)).toBe(false);

  await page.locator("#t-next").click();
  await expectPlaying(page, JOB_ID);
});

test("a Next from song is added to Up Next and leaves the list", async ({ page, request }) => {
  await playSetlist(page, request);
  await page.locator(`${FROM_ROWS} .upnext-add`).click();
  await expect(page.locator("#upNextList .upnext-row")).toHaveAttribute("data-id", JOB_ID);
  await expect(page.locator("#upNextFrom")).toBeHidden();
});

test("a Next from song plays now and Up Next stays empty", async ({ page, request }) => {
  await playSetlist(page, request);
  await page.locator(`${FROM_ROWS} .upnext-play`).click();
  await expectPlaying(page, JOB_ID);
  await expect(page.locator("#upNextList .upnext-row")).toHaveCount(0);
});

/** Play the first song shown in a Browse view, with `view` its nav entry. */
async function playFirstInBrowse(page, view) {
  await openBrowse(page, view);
  const rows = page.locator("#browseResults .cat-item[data-id]");
  const ids = await rows.evaluateAll((els) => els.map((el) => el.dataset.id));
  await rows.first().dblclick();
  await expectInPlayer(page, ids[0]);
  await openInspectorTab(page, "upnext");
  return ids;
}

test("a song played from All songs makes that the list Next follows", async ({ page }) => {
  await openStudio(page);
  const [, second] = await playFirstInBrowse(page, "all");
  await expect(page.locator("#upNextFromLabel")).toHaveText("Next from: All songs");
  await expect(page.locator(FROM_ROWS)).toHaveAttribute("data-id", second);
});

test("a song played from a folder makes that folder the list Next follows", async ({ page }) => {
  await openStudio(page);
  const [, second] = await playFirstInBrowse(page, "folder:f-unsorted");
  await expect(page.locator("#upNextFromLabel")).toHaveText("Next from: Unsorted");
  await expect(page.locator(FROM_ROWS)).toHaveAttribute("data-id", second);
});

test("Back and Forward in the song header change the song shown, not the one playing", async ({ page }) => {
  await openSiblingOverPlaying(page);
  const back = page.locator("#songBackBtn");
  const forward = page.locator("#songForwardBtn");
  await expect(forward).toBeDisabled();

  await back.click();
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
  expect(await shownId(page)).toBeNull();
  await expect(back).toBeDisabled();
  await forward.click();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
  await seek(page, 0);

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
  expect(await playingId(page)).toBe(JOB_ID);
  expect(await isPlaying(page)).toBe(true);
});
