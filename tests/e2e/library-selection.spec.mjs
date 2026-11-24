// A single click on a song selects and opens it, leaving the song that plays alone;
// a double-click, Enter or the row's Play button opens it and plays it.

import { test, expect } from "@playwright/test";
import { ROW_KEY, ROW_PLAY_CLASS, SELECTED_ROW_CLASS } from "../../static/js/rovingRows.js";
import {
  JOB_ID,
  KEY,
  JOB_LIST_URL,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  fixtureTrack,
  openInspectorTab,
  openStudio,
  seedCatalogState,
  stubExportEndpoints,
  stubFavorites,
  stubServerTrash,
  stubUpdateCheck,
  openBrowse,
  browseRow,
} from "./helpers.mjs";

const SONG_ROW = "#catalogList .cat-item";
const SETLIST_SONG = "#browseResults .setlist-song";
const PLAY = `.${ROW_PLAY_CLASS}`;
const SELECTED = new RegExp(`\\b${SELECTED_ROW_CLASS}\\b`);
const ACTIVE = /\bactive\b/;
const OPEN_TIMEOUT_MS = 20000;
// Long enough for a click's load to have reached the studio, had it started one.
const SETTLE_MS = 600;
const SHOWN_OPACITY = "1";
const ONE_OPEN = 1;

test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const songRow = (page, id) => page.locator(`${SONG_ROW}[data-id="${id}"]`).first();
const setlistSong = (page, id) => page.locator(`${SETLIST_SONG}[data-id="${id}"]`);
const openId = (page) => page.evaluate(async () => (await import("/js/catalog.js")).getCurrentTrackInfo()?.id ?? null);
const playingId = (page) => page.evaluate(async () => (await import("/js/state.js")).currentJobId);
const isPlaying = (page) => page.evaluate(async () => (await import("/js/state.js")).audioEngine?.isPlaying() === true);

/** How many times the page starts opening a song: every open asks for its peaks first, once. */
function countOpens(page, id) {
  const opens = { count: 0 };
  page.on("request", function onPeaksRead(req) {
    if (new URL(req.url()).pathname === `/api/jobs/${id}/peaks`) opens.count++;
  });
  return opens;
}

/** The library with nothing open yet, both fixture songs in it. */
async function openLibrary(page, { favorite = false } = {}) {
  const ids = [JOB_ID, SIBLING_JOB_ID];
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: ids, color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: Object.fromEntries(ids.map((id) => [id, { ...fixtureTrack(id, id), favorite }])),
  });
  await stubFavorites(page);
  const trash = await stubServerTrash(page);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  const listed = page.waitForResponse(JOB_LIST_URL);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await listed;
  await expect(songRow(page, SIBLING_JOB_ID)).toBeVisible();
  return { trash };
}

async function startPlayback(page) {
  await page.locator("#t-play").click();
  await expect.poll(() => isPlaying(page)).toBe(true);
}

async function expectSelectedAndOpened(page, row, id) {
  await expect(row).toHaveClass(SELECTED);
  await expect(row).toBeFocused();
  await expect(row).toHaveClass(ACTIVE, { timeout: OPEN_TIMEOUT_MS });
  expect(await openId(page)).toBe(id);
}

async function expectPlaying(page, id) {
  await expect.poll(() => playingId(page), { timeout: OPEN_TIMEOUT_MS }).toBe(id);
  await expect.poll(() => isPlaying(page), { timeout: OPEN_TIMEOUT_MS }).toBe(true);
}

/** Delete on the focused row bins nothing: `key` then moves on by keyboard, whose Delete bins `binnedId`. */
async function expectDeleteUnarmed(page, trash, key, binnedId) {
  await page.keyboard.press(KEY.DELETE);
  await page.keyboard.press(key);
  await expect(songRow(page, binnedId)).toBeFocused();
  await page.keyboard.press(KEY.DELETE);
  await expect.poll(() => trash.calls.length).toBeGreaterThan(0);
  expect(trash.calls).toEqual([{ id: binnedId, action: "trash" }]);
}

const opacityOf = (locator) => locator.evaluate((el) => getComputedStyle(el).opacity);
const styleOf = (locator, property) => locator.evaluate((el, name) => getComputedStyle(el)[name], property);

test.describe("song rows", () => {
  test("a click selects and opens a song while the one playing keeps playing", async ({ page }) => {
    await openStudio(page);
    await startPlayback(page);

    await songRow(page, SIBLING_JOB_ID).click();
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(SELECTED);
    await expect.poll(() => openId(page)).toBe(SIBLING_JOB_ID);
    await expect(songRow(page, SIBLING_JOB_ID)).not.toHaveClass(ACTIVE);
    await expect(songRow(page, JOB_ID)).toHaveClass(ACTIVE);
    await expect(songRow(page, JOB_ID)).not.toHaveClass(SELECTED);
    expect(await playingId(page)).toBe(JOB_ID);
    expect(await isPlaying(page)).toBe(true);
  });

  test("a click with nothing open opens the song, once and paused", async ({ page }) => {
    await openLibrary(page);
    const opens = countOpens(page, SIBLING_JOB_ID);
    await songRow(page, SIBLING_JOB_ID).click();
    await expectSelectedAndOpened(page, songRow(page, SIBLING_JOB_ID), SIBLING_JOB_ID);
    await page.waitForTimeout(SETTLE_MS);
    expect(opens.count).toBe(ONE_OPEN);
    expect(await isPlaying(page)).toBe(false);
  });

  test("a click selects a song without arming Delete", async ({ page }) => {
    const { trash } = await openLibrary(page);
    await songRow(page, SIBLING_JOB_ID).click();
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(SELECTED);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    // Once in the player, the song heads the sidebar's list.
    await expect(page.locator(SONG_ROW).first()).toHaveAttribute("data-id", SIBLING_JOB_ID);
    await expectDeleteUnarmed(page, trash, ROW_KEY.NEXT, JOB_ID);
  });

  test("a double-click opens the song once and plays it", async ({ page }) => {
    await openStudio(page);
    const opens = countOpens(page, SIBLING_JOB_ID);
    await songRow(page, SIBLING_JOB_ID).dblclick();
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(ACTIVE, { timeout: OPEN_TIMEOUT_MS });
    await expectPlaying(page, SIBLING_JOB_ID);
    expect(opens.count).toBe(ONE_OPEN);
  });

  test("Enter on the selected song opens it and plays it", async ({ page }) => {
    await openStudio(page);
    await songRow(page, JOB_ID).click();
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(SELECTED);
    await page.keyboard.press(ROW_KEY.OPEN);
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(ACTIVE, { timeout: OPEN_TIMEOUT_MS });
    await expectPlaying(page, SIBLING_JOB_ID);
  });

  test("the Play button on the cover opens the song and plays it", async ({ page }) => {
    await openStudio(page);
    const row = songRow(page, SIBLING_JOB_ID);
    await row.hover();
    await row.locator(PLAY).click();
    await expect(row).toHaveClass(ACTIVE, { timeout: OPEN_TIMEOUT_MS });
    await expect(row).toBeFocused();
    await expectPlaying(page, SIBLING_JOB_ID);
  });

  test("opening with the Play button leaves Delete unarmed", async ({ page }) => {
    const { trash } = await openLibrary(page);
    const row = songRow(page, JOB_ID);
    await row.hover();
    await row.locator(PLAY).click();
    await expect(row).toHaveClass(ACTIVE, { timeout: OPEN_TIMEOUT_MS });
    await expect(row).toBeFocused();
    await expectDeleteUnarmed(page, trash, ROW_KEY.NEXT, SIBLING_JOB_ID);
  });

  test("arrows move the selection and open nothing", async ({ page }) => {
    await openStudio(page);
    await songRow(page, JOB_ID).click();
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(SELECTED);
    await expect(songRow(page, JOB_ID)).not.toHaveClass(SELECTED);
    await page.keyboard.press(ROW_KEY.PREVIOUS);
    await expect(songRow(page, JOB_ID)).toHaveClass(SELECTED);
    await expect(songRow(page, SIBLING_JOB_ID)).not.toHaveClass(SELECTED);
    expect(await openId(page)).toBe(JOB_ID);
  });
});

test.describe("selected and open look different", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("a frame marks the open song, a coral fill the playing one, Play only off the playing row", async ({ page }) => {
    await openStudio(page);
    await startPlayback(page);
    const open = songRow(page, JOB_ID);
    const selected = songRow(page, SIBLING_JOB_ID);
    await selected.click();
    await expect.poll(() => openId(page)).toBe(SIBLING_JOB_ID);
    await page.locator("#browseBtn").focus();
    await page.mouse.move(0, 0);

    await expect(selected).toHaveClass(SELECTED);
    expect(await styleOf(selected, "borderTopColor")).not.toBe(await styleOf(open, "borderTopColor"));
    expect(await styleOf(selected, "backgroundColor")).not.toBe(await styleOf(open, "backgroundColor"));
    expect(await styleOf(open.locator(".cat-title"), "color")).not.toBe(
      await styleOf(selected.locator(".cat-title"), "color"),
    );
    await expect(selected.locator(PLAY)).toBeVisible();
    await expect.poll(() => opacityOf(selected.locator(".cat-actions"))).toBe(SHOWN_OPACITY);

    await open.hover();
    await expect(open.locator(PLAY)).toBeHidden();
  });
});

test.describe("other song lists", () => {
  test("Favourites: a click opens, a double-click plays", async ({ page }) => {
    await openLibrary(page, { favorite: true });
    await openBrowse(page, "fav");
    const row = browseRow(page, SIBLING_JOB_ID);
    // A card's middle is its Play cover, so the clicks aim at its title.
    await row.locator(".cat-title").click();
    await expectSelectedAndOpened(page, row, SIBLING_JOB_ID);
    await row.locator(".cat-title").dblclick();
    await expectPlaying(page, SIBLING_JOB_ID);
  });

  test("search results: a click opens, Enter plays", async ({ page }) => {
    await openLibrary(page);
    await openBrowse(page);
    await page.locator("#browseSearch").fill(SIBLING_TITLE);
    await expect(browseRow(page, JOB_ID)).toHaveCount(0);
    const row = browseRow(page, SIBLING_JOB_ID);
    await row.locator(".cat-title").click();
    await expectSelectedAndOpened(page, row, SIBLING_JOB_ID);
    await page.keyboard.press(ROW_KEY.OPEN);
    await expectPlaying(page, SIBLING_JOB_ID);
  });

  test("Setlists: a click opens, the playing song is marked, double-click and Play play", async ({ page, request }) => {
    const { id } = await (await request.post("/api/setlists", { data: { name: "Gig", song_ids: [JOB_ID, SIBLING_JOB_ID] } })).json();
    await openStudio(page);
    await startPlayback(page);
    await openBrowse(page, `setlist:${id}`);
    const song = setlistSong(page, SIBLING_JOB_ID);

    await song.click();
    await expect(song).toHaveClass(SELECTED);
    await expect.poll(() => openId(page)).toBe(SIBLING_JOB_ID);
    await expect(setlistSong(page, JOB_ID)).toHaveClass(ACTIVE);
    expect(await playingId(page)).toBe(JOB_ID);
    await setlistSong(page, JOB_ID).hover();
    await expect(setlistSong(page, JOB_ID).locator(PLAY)).toHaveCount(0);

    await song.dblclick();
    await expectPlaying(page, SIBLING_JOB_ID);
    await expect(page.locator("#browseLibrary")).toBeHidden();
    await openBrowse(page, `setlist:${id}`);
    await setlistSong(page, JOB_ID).hover();
    await setlistSong(page, JOB_ID).locator(PLAY).click();
    await expectPlaying(page, JOB_ID);
  });

  test("Up Next still plays a row on a single click", async ({ page }) => {
    await openStudio(page);
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent("upnext:add", { detail: { id } })), SIBLING_JOB_ID);
    await openInspectorTab(page, "upnext");
    await page.locator("#upNextList .upnext-play").click();
    await expect.poll(() => openId(page), { timeout: OPEN_TIMEOUT_MS }).toBe(SIBLING_JOB_ID);
  });
});
