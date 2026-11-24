// While a song is shown over the one playing, everything bound to the player stays
// with the playing song: Stage, the footer, Up Next, Lyrics, Tempo, Sing along, its mix.

import { test, expect } from "@playwright/test";
import { DEFAULT_VERSION_ID } from "../../static/js/versionModel.js";
import { ROW_KEY } from "../../static/js/rovingRows.js";
import { singStoreKey } from "../../static/js/stageSingModel.js";
import {
  JOB_ID,
  KEY,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  openInspectorTab,
  openStudio,
  stubServerTrash,
} from "./helpers.mjs";
import {
  LYRICS,
  call,
  enterSingAlong,
  serveLyrics,
  stored,
} from "./singAlongHelpers.mjs";
import {
  LOAD_TIMEOUT_MS,
  expectPlaying,
  isPlaying,
  openSiblingOverPlaying,
  playingId,
  shownId,
  songRow,
  startPlayback,
} from "./openVsPlaying.mjs";

const RENAMED_TITLE = "Renamed while it plays";
const OTHER_VERSION = "Alt mix";
const OTHER_VERSION_STEMS = ["vocals", "drums"];
const SIBLING_LYRICS = {
  ...LYRICS,
  synced: "[00:01.00] A line only the shown song has\n[00:03.00] And another one",
};
const versionsUrl = (id) => `/api/jobs/${id}/versions`;
const timedLines = (page) => page.evaluate(
  async () => (await import("/js/lyrics.js")).getTimedLyricLines().map((line) => line.text),
);
const linesOf = (lyrics) => lyrics.synced.split("\n").map((line) => line.replace(/^\[[^\]]+\]\s*/, ""));

async function openVersionId(request, id) {
  const { open_version: openId } = await (await request.get(versionsUrl(id))).json();
  return openId ?? DEFAULT_VERSION_ID;
}

async function expectAPausedWithBShown(page) {
  await expect.poll(() => isPlaying(page)).toBe(false);
  expect(await playingId(page)).toBe(JOB_ID);
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
}

test.describe("the player's own controls act on the playing song", () => {
  test("in Stage the footer's Play pauses and resumes the playing song, never the shown one", async ({ page }) => {
    await openSiblingOverPlaying(page);
    await page.locator("#stageModeBtn").click();
    await page.locator("#t-play").click();
    await expectAPausedWithBShown(page);
    await page.locator("#t-play").click();
    await expectPlaying(page, JOB_ID);
    expect(await shownId(page)).toBe(SIBLING_JOB_ID);
  });

  test("the footer Play pauses the playing song and leaves the shown one open", async ({ page }) => {
    await openSiblingOverPlaying(page);
    await page.locator("#t-play").click();
    await expectAPausedWithBShown(page);
    expect(await shownId(page)).toBe(SIBLING_JOB_ID);
  });

  test("the footer's Playing line follows a rename of the playing song", async ({ page }) => {
    await openSiblingOverPlaying(page);
    await call(page, "/js/catalog.js", "applyRenamedState", JOB_ID, { user_title: RENAMED_TITLE });
    await expect(page.locator("#footerNowTitle")).toHaveText(RENAMED_TITLE);
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
  });
});

test.describe("the shown song", () => {
  test("goes away when it is put in the Trash, and Play then resumes the playing song", async ({ page }) => {
    const trash = await stubServerTrash(page);
    await openSiblingOverPlaying(page);
    // A clicked row leaves Delete unarmed; the keyboard's row bins it.
    await page.keyboard.press(ROW_KEY.PREVIOUS);
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press(KEY.DELETE);
    await expect.poll(() => trash.calls.length).toBeGreaterThan(0);
    await expect(page.locator("#openPreview")).toBeHidden();
    await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
    expect(await shownId(page)).toBeNull();
    await page.locator("#t-play").click();
    await expect.poll(() => isPlaying(page)).toBe(false);
    await page.locator("#t-play").click();
    await expectPlaying(page, JOB_ID);
  });

  test("its version pill picks its own version, loads it paused and leaves the playing song's mix alone", async ({ page, request }) => {
    const res = await request.post(versionsUrl(SIBLING_JOB_ID), { data: { name: OTHER_VERSION, stems: OTHER_VERSION_STEMS, open: false } });
    expect(res.ok()).toBe(true);
    const otherId = (await res.json()).version.id;
    try {
      await openSiblingOverPlaying(page);
      await page.locator("#npVersionBtn").click();
      await page.getByRole("menuitemradio", { name: OTHER_VERSION }).click();
      await expect.poll(() => playingId(page), { timeout: LOAD_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
      expect(await isPlaying(page)).toBe(false);
      expect(await openVersionId(request, SIBLING_JOB_ID)).toBe(otherId);
      expect(await openVersionId(request, JOB_ID)).toBe(DEFAULT_VERSION_ID);
    } finally {
      await request.post(`${versionsUrl(SIBLING_JOB_ID)}/${DEFAULT_VERSION_ID}/open`);
      await request.delete(`${versionsUrl(SIBLING_JOB_ID)}/${otherId}`);
    }
  });
});

test.describe("what stays with the playing song", () => {
  test("Up Next's Now playing names the playing song", async ({ page }) => {
    await openSiblingOverPlaying(page);
    await openInspectorTab(page, "upnext");
    await expect(page.locator("#upNextNow")).toContainText(TRACK_TITLE);
    await expect(page.locator("#upNextNow")).not.toContainText(SIBLING_TITLE);
  });

  test("Lyrics and Tempo keep the playing song's", async ({ page }) => {
    await serveLyrics(page);
    await page.route(`**/api/jobs/${SIBLING_JOB_ID}/lyrics`, (route) => route.fulfill({ status: 200, json: SIBLING_LYRICS }));
    await openSiblingOverPlaying(page);
    await call(page, "/js/catalog.js", "showLyricsView");
    await expect.poll(() => timedLines(page), { timeout: LOAD_TIMEOUT_MS }).toEqual(linesOf(LYRICS));
    const bpm = await page.evaluate(async () => (await import("/js/tempoTools.js")).shownBpm());
    await openInspectorTab(page, "tempo");
    expect(await page.evaluate(async () => (await import("/js/tempoTools.js")).shownBpm())).toBe(bpm);
    expect(await timedLines(page)).toEqual(linesOf(LYRICS));
  });

  test("Sing along keeps the playing song's lyrics, Voice switch and saved voice", async ({ page }) => {
    await serveLyrics(page);
    await page.route(`**/api/jobs/${SIBLING_JOB_ID}/lyrics`, (route) => route.fulfill({ status: 200, json: SIBLING_LYRICS }));
    await openStudio(page);
    await startPlayback(page);
    await enterSingAlong(page);
    await page.locator("#singVoiceBtn").click();
    await expect(page.locator("#singVoiceBtn")).toHaveAttribute("aria-checked", "true");

    await call(page, "/js/openSong.js", "openSong", SIBLING_JOB_ID);
    await expect.poll(() => shownId(page)).toBe(SIBLING_JOB_ID);
    await expect(page.locator("#singVoiceBtn")).toHaveAttribute("aria-checked", "true");
    expect(await timedLines(page)).toEqual(linesOf(LYRICS));
    await page.locator("#singVoiceBtn").click();
    expect(await stored(page, singStoreKey(JOB_ID))).toEqual({ voice: false });
    expect(await stored(page, singStoreKey(SIBLING_JOB_ID))).toBeNull();
  });
});

const NARROW_WINDOWS = [
  { width: 1024, height: 768 },
  { width: 620, height: 900 },
];
const AT_MOST_ONE_MORE_ROW = 1;

/** Rows the footer's zones sit on: distinct tops among the shown ones. */
const footerRows = (page) => page.evaluate(() => {
  const groups = [...document.querySelectorAll(".ft > *")]
    .filter((el) => el.getClientRects().length > 0);
  return new Set(groups.map((el) => Math.round(el.getBoundingClientRect().top))).size;
});

for (const viewport of NARROW_WINDOWS) {
  test(`the Playing line adds at most one footer row at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openStudio(page);
    await startPlayback(page);
    const before = await footerRows(page);
    await call(page, "/js/openSong.js", "openSong", SIBLING_JOB_ID);
    await expect(page.locator(".ft-now-playing")).toBeVisible();
    await expect.poll(() => footerRows(page)).toBeLessThanOrEqual(before + AT_MOST_ONE_MORE_ROW);
  });
}
