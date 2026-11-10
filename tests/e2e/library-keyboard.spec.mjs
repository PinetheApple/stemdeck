// The library works from the keyboard (#46): each list is one Tab stop, the
// arrows move between its rows, Enter opens one, and Right/Left reach the row's
// own buttons. Songs, Favourites, search results and Setlists all behave alike.
//
// Writes that would change the shared backend (favourites, trash) are stubbed;
// the setlist made here is deleted after each test.

import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  fixtureTrack,
  readCatalogState,
  seedCatalogState,
  stubExportEndpoints,
  stubFavorites,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";

const SONG_ROW = "#catalogList .cat-item";
const LIBRARY_ROWS = "#catalogList :is(.cat-item, .folder-head)";
const SETLIST_ROWS = "#setlistsList :is(.setlist-head, .setlist-song)";

test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const songRow = (page, id) => page.locator(`${SONG_ROW}[data-id="${id}"]`);

async function openLibrary(page, { favorite = false } = {}) {
  const track = (id) => ({ ...fixtureTrack(id, id), favorite });
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: { [JOB_ID]: track(JOB_ID), [SIBLING_JOB_ID]: track(SIBLING_JOB_ID) },
  });
  await stubFavorites(page);
  const trash = await stubServerTrash(page);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(songRow(page, SIBLING_JOB_ID)).toBeVisible();
  return { trash };
}

/** How many Tab stops the rows matching `rows` and everything inside them make. */
function rowTabStops(page, rows) {
  return page.evaluate((selector) => {
    const inRows = [...document.querySelectorAll(selector)].flatMap((row) => [row, ...row.querySelectorAll("*")]);
    return inRows.filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length).length;
  }, rows);
}

const focusedRowKey = (page) =>
  page.evaluate(() => {
    const row = document.activeElement?.closest(".cat-item, .folder-head, .setlist-song, .setlist-head");
    if (!row) return null;
    return row.dataset.id ?? row.closest("[data-id]")?.dataset.id ?? null;
  });

test.describe("song rows", () => {
  test("the list is one Tab stop, landing on a song", async ({ page }) => {
    await openLibrary(page);
    expect(await rowTabStops(page, LIBRARY_ROWS)).toBe(1);

    await page.locator("#newFolderBtn").focus();
    await page.keyboard.press("Tab");
    await expect(songRow(page, JOB_ID)).toBeFocused();
    await page.keyboard.press("Tab");
    expect(await focusedRowKey(page)).toBeNull();
  });

  test("arrows, Home and End move between rows, folder heads included", async ({ page }) => {
    await openLibrary(page);
    await songRow(page, JOB_ID).focus();
    const head = page.locator('#catalogList .folder[data-id="f-unsorted"] > .folder-head');

    await page.keyboard.press("ArrowDown");
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(head).toBeFocused();
    await page.keyboard.press("End");
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(songRow(page, JOB_ID)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(head).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(head.locator("..")).toHaveClass(/collapsed/);
    await page.keyboard.press("ArrowDown");
    await expect(head).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(head.locator("..")).not.toHaveClass(/collapsed/);
  });

  test("Enter opens the focused song and the row keeps focus", async ({ page }) => {
    await openLibrary(page);
    await songRow(page, SIBLING_JOB_ID).focus();
    await page.keyboard.press("Enter");
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(/\bactive\b/, { timeout: 20000 });
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
  });

  test("Right and Left walk the row's buttons, which stay out of the Tab order", async ({ page }) => {
    await openLibrary(page);
    const row = songRow(page, JOB_ID);
    await row.focus();

    await page.keyboard.press("ArrowRight");
    await expect(row.locator(".cat-upnext")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(row.locator(".cat-more")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(row.locator(".cat-fav")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row.locator(".cat-fav")).toHaveAttribute("aria-pressed", "true");
    await expect(row.locator(".cat-fav")).toBeFocused();

    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await expect(row).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
  });

  test("Delete bins the focused song and focus moves to the next one", async ({ page }) => {
    const { trash } = await openLibrary(page);
    await songRow(page, JOB_ID).focus();
    await page.keyboard.press("Delete");

    await expect.poll(() => trash.calls).toEqual([{ id: JOB_ID, action: "trash" }]);
    expect((await readCatalogState(page)).folders.find((f) => f.id === "trash").items).toEqual([JOB_ID]);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
  });
});

test.describe("other song lists", () => {
  test("Favourites rove the same way", async ({ page }) => {
    await openLibrary(page, { favorite: true });
    await page.locator(".rail-favorites").click();
    await expect(songRow(page, JOB_ID)).toBeVisible();
    expect(await rowTabStops(page, LIBRARY_ROWS)).toBe(1);

    await page.locator(`${SONG_ROW}[tabindex="0"]`).focus();
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    const first = await focusedRowKey(page);
    await page.keyboard.press("ArrowDown");
    expect(await focusedRowKey(page)).not.toBe(first);
    expect([JOB_ID, SIBLING_JOB_ID]).toContain(await focusedRowKey(page));
  });

  test("search results rove the same way", async ({ page }) => {
    await openLibrary(page);
    await page.locator("#catalogSearch").fill("Fixture");
    await expect(songRow(page, SIBLING_JOB_ID)).toBeVisible();
    expect(await rowTabStops(page, LIBRARY_ROWS)).toBe(1);

    await songRow(page, JOB_ID).focus();
    await page.keyboard.press("ArrowDown");
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
  });
});

test.describe("setlists", () => {
  test("a setlist is one Tab stop, its songs open with Enter and its buttons sit on Right", async ({ page, request }) => {
    await request.post("/api/setlists", { data: { name: "Keys", song_ids: [JOB_ID, SIBLING_JOB_ID] } });
    await openLibrary(page);
    await page.locator("#libTabSetlists").click();
    const songs = page.locator(".setlist-song");
    await expect(songs).toHaveCount(2);
    expect(await rowTabStops(page, SETLIST_ROWS)).toBe(1);

    await page.locator("#libTabSetlists").focus();
    await page.keyboard.press("Tab");
    await expect(songs.first()).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".setlist-head")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".setlist-play")).toBeFocused();

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(songs.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(songs.nth(1).locator(".setlist-song-up")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(/\bactive\b/, { timeout: 20000 });
  });
});
