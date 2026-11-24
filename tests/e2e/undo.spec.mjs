// Undo after a removal: Move to Trash, Clear Up Next and removing a song from a
// setlist each show a short message with Undo; Undo puts things back as they were.

import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  JOB_LIST_URL,
  KEY,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  browseRow,
  fixtureTrack,
  openBrowse,
  openInspectorTab,
  openStudio,
  seedCatalogState,
  stubExportEndpoints,
  stubFavorites,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";

const SETLISTS_PATH = "/api/setlists";
const SETLIST_NAME = "Gig";
const UP_NEXT_KEY = "stemdeck.upNext";
const FOLDER_ID = "f-rock";
// Queued, but in no library here, so it cannot play.
const UNPLAYABLE_ID = "e2e0dead0000";
const TOAST = ".undo-toast";
// Longer than the message stays up.
const PAST_THE_TOAST_MS = 8000;
const PLAY_SECONDS = 1;
const SECONDS_TRASHED = 1.5;
// How far the playhead may move between reading it and the trash landing.
const POSITION_SLACK_S = 0.75;
const LOAD_TIMEOUT_MS = 20000;
const trashCall = (id) => ({ id, action: "trash" });
const restoreCall = (id) => ({ id, action: "restore" });
const toast = (page) => page.locator(TOAST);
const storedUpNext = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), UP_NEXT_KEY);
const upNextIds = (page) => page.locator("#upNextList .upnext-row").evaluateAll((rows) => rows.map((r) => r.dataset.id));
const folderRowIds = (page) => page.locator("#browseResults .cat-item").evaluateAll((rows) => rows.map((r) => r.dataset.id));
const serverSongIds = async (request) => (await (await request.get(SETLISTS_PATH)).json())[0]?.song_ids;

test.afterEach(async ({ request }) => {
  const res = await request.get(SETLISTS_PATH);
  for (const setlist of await res.json()) await request.delete(`${SETLISTS_PATH}/${setlist.id}`);
});

/** Both songs in Rock, the sibling first, with Up Next as stored. */
async function openLibrary(page, { upNext = [] } = {}) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [], color: null },
      { id: FOLDER_ID, name: "Rock", items: [SIBLING_JOB_ID, JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: { [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE), [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE) },
  });
  await page.addInitScript(({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids)), { key: UP_NEXT_KEY, ids: upNext });
  await stubFavorites(page);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  const server = await stubServerTrash(page);
  const listed = page.waitForResponse(JOB_LIST_URL);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await listed;
  return server;
}

async function trashFromMenu(page, row) {
  await row.hover();
  await row.locator(".cat-more, .song-card-more").first().click();
  await page.locator(".song-menu").getByRole("menuitem", { name: "Move to Trash" }).click();
}

const movedText = (title) => `Moved “${title}” to the Trash`;

test("Move to Trash shows Undo; Undo puts the song back in its folder place and its Up Next place", async ({ page }) => {
  const server = await openLibrary(page, { upNext: [JOB_ID, SIBLING_JOB_ID] });
  await openBrowse(page, `folder:${FOLDER_ID}`);
  await page.locator("#browseListBtn").click();
  expect(await folderRowIds(page)).toEqual([SIBLING_JOB_ID, JOB_ID]);

  await trashFromMenu(page, browseRow(page, SIBLING_JOB_ID));
  await expect(toast(page)).toHaveAttribute("role", "status");
  await expect(toast(page)).toContainText(movedText(SIBLING_TITLE));
  await expect.poll(() => folderRowIds(page)).toEqual([JOB_ID]);
  await expect.poll(() => storedUpNext(page)).toEqual([JOB_ID]);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(toast(page)).toHaveCount(0);
  await expect.poll(() => folderRowIds(page)).toEqual([SIBLING_JOB_ID, JOB_ID]);
  await expect.poll(() => storedUpNext(page)).toEqual([JOB_ID, SIBLING_JOB_ID]);
  await expect.poll(() => server.calls).toEqual([trashCall(SIBLING_JOB_ID), restoreCall(SIBLING_JOB_ID)]);
});

test("the toast goes by itself after a few seconds, and the trash stands", async ({ page }) => {
  await page.clock.install();
  const server = await openLibrary(page);
  await openBrowse(page, `folder:${FOLDER_ID}`);
  await trashFromMenu(page, browseRow(page, SIBLING_JOB_ID));
  await expect(toast(page)).toBeVisible();

  await page.clock.fastForward(PAST_THE_TOAST_MS);
  await expect(toast(page)).toHaveCount(0);
  await openBrowse(page, "trash");
  await expect(browseRow(page, SIBLING_JOB_ID)).toBeVisible();
  expect(server.calls).toEqual([trashCall(SIBLING_JOB_ID)]);
});

test("Dismiss closes the toast, Esc leaves it, and a new one replaces it", async ({ page }) => {
  await openLibrary(page);
  await openBrowse(page, `folder:${FOLDER_ID}`);
  await trashFromMenu(page, browseRow(page, SIBLING_JOB_ID));
  await trashFromMenu(page, browseRow(page, JOB_ID));
  await expect(toast(page)).toHaveCount(1);
  await expect(toast(page)).toContainText(movedText(TRACK_TITLE));

  await page.keyboard.press(KEY.ESCAPE);
  await expect(page.locator("#browseLibrary")).toBeHidden();
  await expect(toast(page)).toBeVisible();
  await toast(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(toast(page)).toHaveCount(0);
});

test("Clear Up Next shows Undo; Undo restores the list in order", async ({ page }) => {
  await openLibrary(page, { upNext: [JOB_ID, SIBLING_JOB_ID] });
  await openInspectorTab(page, "upnext");
  await expect.poll(() => upNextIds(page)).toEqual([JOB_ID, SIBLING_JOB_ID]);

  await page.locator("#upNextClear").click();
  await expect.poll(() => upNextIds(page)).toEqual([]);
  await expect(toast(page)).toContainText("Up Next cleared");

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => upNextIds(page)).toEqual([JOB_ID, SIBLING_JOB_ID]);
  await expect.poll(() => storedUpNext(page)).toEqual([JOB_ID, SIBLING_JOB_ID]);
});

test("removing from a setlist shows Undo; Undo puts it back at its position on the server", async ({ page, request }) => {
  await request.post(SETLISTS_PATH, { data: { name: SETLIST_NAME, song_ids: [JOB_ID, SIBLING_JOB_ID] } });
  await openLibrary(page);
  await openBrowse(page);
  await page.locator(`#browseNav .browse-nav-btn[data-view^="setlist:"]`, { hasText: SETLIST_NAME }).click();
  const row = page.locator(`#browseResults .setlist-song[data-id="${JOB_ID}"]`);
  await row.hover();
  await row.locator(".setlist-song-remove").click();
  await expect(toast(page)).toContainText(`Removed from ${SETLIST_NAME}`);
  await expect.poll(() => serverSongIds(request)).toEqual([SIBLING_JOB_ID]);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => serverSongIds(request)).toEqual([JOB_ID, SIBLING_JOB_ID]);
  await expect(page.locator("#browseResults .setlist-song").first()).toHaveAttribute("data-id", JOB_ID);
});

test("Delete on a keyboard-reached row shows the same Undo", async ({ page }) => {
  const server = await openLibrary(page);
  await openBrowse(page, `folder:${FOLDER_ID}`);
  await page.locator("#browseListBtn").click();
  await browseRow(page, SIBLING_JOB_ID).focus();
  await page.keyboard.press(KEY.DELETE);
  await expect(toast(page)).toContainText(movedText(SIBLING_TITLE));
  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => folderRowIds(page)).toEqual([SIBLING_JOB_ID, JOB_ID]);
  await expect.poll(() => server.calls).toEqual([trashCall(SIBLING_JOB_ID), restoreCall(SIBLING_JOB_ID)]);
});

/** Where the player's playhead is, in seconds. */
const playhead = (page) => page.evaluate(() => import("/js/transport.js").then((m) => m.transport()?.getCurrentTime?.() ?? 0));
const isPlaying = (page) => page.evaluate(() => import("/js/transport.js").then((m) => m.transport()?.isPlaying() === true));

test("Undo after trashing the playing song opens it again, paused where it was", async ({ page }) => {
  await stubServerTrash(page);
  await openStudio(page);
  await page.locator("#t-play").click();
  await expect.poll(() => playhead(page), { timeout: LOAD_TIMEOUT_MS }).toBeGreaterThan(PLAY_SECONDS);

  const at = await playhead(page);
  await page.locator("#songMoreBtn").click();
  await page.locator(".song-menu").getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(toast(page)).toContainText(movedText(TRACK_TITLE));
  await page.waitForTimeout(SECONDS_TRASHED * 1000);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE, { timeout: LOAD_TIMEOUT_MS });
  await expect.poll(() => isPlaying(page)).toBe(false);
  await expect.poll(() => playhead(page)).toBeGreaterThanOrEqual(at);
  expect(await playhead(page)).toBeLessThan(at + POSITION_SLACK_S);
  await expect(page.locator("#songMoreBtn")).toBeEnabled();
});

test("Undo puts a song back at its Up Next place behind a song that cannot play", async ({ page }) => {
  await openLibrary(page, { upNext: [UNPLAYABLE_ID, JOB_ID, SIBLING_JOB_ID] });
  await openBrowse(page, `folder:${FOLDER_ID}`);
  await trashFromMenu(page, browseRow(page, SIBLING_JOB_ID));
  await expect.poll(() => storedUpNext(page)).toEqual([UNPLAYABLE_ID, JOB_ID]);

  await toast(page).getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => storedUpNext(page)).toEqual([UNPLAYABLE_ID, JOB_ID, SIBLING_JOB_ID]);
});

test("Undo after trashing the playing song leaves a song played since in the player", async ({ page }) => {
  await stubServerTrash(page);
  await openStudio(page);
  await page.locator("#t-play").click();
  await expect.poll(() => isPlaying(page), { timeout: LOAD_TIMEOUT_MS }).toBe(true);
  await page.locator("#songMoreBtn").click();
  await page.locator(".song-menu").getByRole("menuitem", { name: "Move to Trash" }).click();
  await expect(toast(page)).toBeVisible();

  await page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: LOAD_TIMEOUT_MS });
  await toast(page).getByRole("button", { name: "Undo" }).click();

  await expect(page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first()).toBeVisible();
  await page.waitForTimeout(SECONDS_TRASHED * 1000);
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE);
  expect(await isPlaying(page)).toBe(true);
});
