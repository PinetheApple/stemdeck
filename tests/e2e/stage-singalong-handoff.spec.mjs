// Sing along at a song's end: the next song in Up Next with a countdown, Play now and Stay here;
// Play along goes straight on.

import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE, TRACK_TITLE } from "./helpers.mjs";
import {
  SONG_OPEN_TIMEOUT_MS,
  call,
  endSong,
  enterSingAlong,
  openSongId,
  seedUpNext,
  seekTo,
  serveLyrics,
} from "./singAlongHelpers.mjs";

const COUNTDOWN_SECONDS = "5";
const COUNTDOWN_RUNS_OUT_MS = 8000;
// Longer than the countdown, to see that nothing starts after it was called off.
const PAST_COUNTDOWN_MS = 6000;
const SEEK_BACK_SEC = 1;
const NO_CONTENT = "none";
const SETLISTS_URL = "/api/setlists";
const TRANSPARENT = "rgba(0, 0, 0, 0)";

const card = (page) => page.locator("#singHandoff");
const stageDimmed = (page) => page.locator("#stageView").evaluate((el, off) => {
  const scrim = getComputedStyle(el, "::after");
  return scrim.content !== off.content && scrim.backgroundColor !== off.background;
}, { content: NO_CONTENT, background: TRANSPARENT });

test.afterEach(async ({ request }) => {
  const res = await request.get(SETLISTS_URL);
  for (const setlist of await res.json()) await request.delete(`${SETLISTS_URL}/${setlist.id}`);
});

async function endInSingAlong(page, queued = [SIBLING_JOB_ID]) {
  await serveLyrics(page);
  await seedUpNext(page, queued);
  await openStudio(page);
  await enterSingAlong(page);
  await endSong(page);
  await expect(card(page)).toBeVisible();
}

async function expectStillOnSong(page) {
  await page.waitForTimeout(PAST_COUNTDOWN_MS);
  expect(await openSongId(page)).toBe(JOB_ID);
}

test.describe("sing along song end", () => {
  test("counts down to the next song, and Stay here keeps this one", async ({ page }) => {
    await endInSingAlong(page);
    await expect(page.locator("#singHandoffTitle")).toHaveText(SIBLING_TITLE);
    await expect(page.locator("#singRingNum")).toHaveText(COUNTDOWN_SECONDS);
    expect(await stageDimmed(page)).toBe(true);
    await page.locator("#singStayBtn").click();
    await expect(card(page)).toBeHidden();
    expect(await stageDimmed(page)).toBe(false);
    await expectStillOnSong(page);
  });

  test("Play now starts the next song with focus on Play, and so does the countdown running out", async ({ page }) => {
    await endInSingAlong(page);
    await page.locator("#singPlayNowBtn").click();
    await expect(page.locator("#t-play")).toBeFocused();
    await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
    await expect(card(page)).toBeHidden();

    await call(page, "/js/upNext.js", "queueUpNext", JOB_ID);
    await endSong(page, SIBLING_JOB_ID);
    await expect(card(page)).toBeVisible();
    await expect.poll(() => openSongId(page), { timeout: COUNTDOWN_RUNS_OUT_MS }).toBe(JOB_ID);
    await expect(page.locator("#t-play")).toBeFocused();
  });

  test("Esc dismisses the countdown like Stay here, and a second Esc leaves Stage", async ({ page }) => {
    await endInSingAlong(page);
    await page.keyboard.press("Escape");
    await expect(card(page)).toBeHidden();
    await expect(page.locator("#stageView")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#stageView")).toBeHidden();
    await expectStillOnSong(page);
  });

  test("a seek calls the countdown off", async ({ page }) => {
    await endInSingAlong(page);
    await seekTo(page, SEEK_BACK_SEC);
    await expect(card(page)).toBeHidden();
    await expectStillOnSong(page);
  });

  test("the card follows Up Next: the next song changes with it, and an empty queue closes it", async ({ page }) => {
    await endInSingAlong(page, [SIBLING_JOB_ID, JOB_ID]);
    await expect(page.locator("#singHandoffTitle")).toHaveText(SIBLING_TITLE);
    await page.locator("#stageQueueBtn").click();
    await page.locator(`#stageQueuePanel .upnext-row[data-id="${SIBLING_JOB_ID}"] .upnext-remove`).click();
    await expect(page.locator("#singHandoffTitle")).toHaveText(TRACK_TITLE);
    await page.locator("#stageQueuePanel #upNextClear").click();
    await expect(card(page)).toBeHidden();
    await expectStillOnSong(page);
  });

  test("a setlist's next song gets the countdown too, and Play now starts it", async ({ page, request }) => {
    const created = await request.post(SETLISTS_URL, { data: { name: "Sing", song_ids: [JOB_ID, SIBLING_JOB_ID] } });
    const { id } = await created.json();
    await serveLyrics(page);
    await openStudio(page);
    await call(page, "/js/setlists.js", "playSetlist", id);
    await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(JOB_ID);
    await call(page, "/js/transport.js", "stopTransport");
    await enterSingAlong(page);
    await endSong(page);
    await expect(card(page)).toBeVisible();
    await expect(page.locator("#singHandoffTitle")).toHaveText(SIBLING_TITLE);
    await page.locator("#singPlayNowBtn").click();
    await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
    await expect(card(page)).toBeHidden();
  });

  test("Play along goes straight to the next song", async ({ page }) => {
    await serveLyrics(page);
    await seedUpNext(page, [SIBLING_JOB_ID]);
    await openStudio(page);
    await page.locator("#stageModeBtn").click();
    await expect(page.locator("#stageLookPlay")).toHaveAttribute("aria-checked", "true");
    await endSong(page);
    await expect.poll(() => openSongId(page), { timeout: SONG_OPEN_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
    await expect(card(page)).toBeHidden();
  });
});
