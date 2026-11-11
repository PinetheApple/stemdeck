// Every list in the library pane is one Tab stop with arrows inside it, so a
// keyboard user gets past a long list in one press instead of one per button.

import { test, expect } from "@playwright/test";
import { ROW_KEY } from "../../static/js/rovingRows.js";
import {
  JOB_ID,
  JOB_LIST_URL,
  KEY,
  SIBLING_JOB_ID,
  fixtureTrack,
  openInspectorTab,
  readCatalogState,
  seedCatalogState,
  stubExportEndpoints,
  stubFavorites,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";

// Held past the restore so the fill has certainly finished.
const HOLD_PAST_RESTORE_FACTOR = 1.5;
const OPEN_TIMEOUT_MS = 20000;
const SONG_ROW = "#catalogList .cat-item";
const LIBRARY_ROWS = "#catalogList :is(.cat-item, .folder-head)";
const SETLIST_ROWS = "#setlistsList :is(.setlist-head, .setlist-song)";
const UPNEXT_ROWS = "#upNextList .upnext-row";
const ACTIVE = /\bactive\b/;

test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const songRow = (page, id) => page.locator(`${SONG_ROW}[data-id="${id}"]`);
const trashHoldMs = (page) => page.evaluate(() => import("/js/catalog.js").then((m) => m.TRASH_HOLD_MS));
const trashCall = (id) => ({ id, action: "trash" });

/** A Delete that does bin, pressed after the one under test: keys run in order, so its call proves the first did nothing. */
async function binSiblingByKeyboard(page, trash) {
  await page.locator("#newFolderBtn").focus();
  await page.keyboard.press(KEY.TAB);
  await page.keyboard.press(ROW_KEY.LAST);
  await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
  await page.keyboard.press(KEY.DELETE);
  await expect.poll(() => trash.calls.length).toBeGreaterThan(0);
  expect(trash.calls).toEqual([trashCall(SIBLING_JOB_ID)]);
}

const trashItems = async (page) => (await readCatalogState(page)).folders.find((f) => f.id === "trash").items;

async function openLibrary(page, { favorite = false, trashed = [] } = {}) {
  const ids = [JOB_ID, SIBLING_JOB_ID];
  const track = (id) => ({ ...fixtureTrack(id, id), favorite });
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: ids.filter((id) => !trashed.includes(id)), color: null },
      { id: "trash", name: "Trash", items: trashed, color: null },
    ],
    tracks: Object.fromEntries(ids.map((id) => [id, track(id)])),
  });
  await stubFavorites(page);
  const trash = await stubServerTrash(page, { trashed });
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  // The startup sync's read must be answered before a quick test ends, or its route outlives the page.
  const listed = page.waitForResponse(JOB_LIST_URL);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await listed;
  await expect(page.locator(LIBRARY_ROWS).first()).toBeAttached();
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
    await page.keyboard.press(KEY.TAB);
    await expect(songRow(page, JOB_ID)).toBeFocused();
    await page.keyboard.press(KEY.TAB);
    expect(await focusedRowKey(page)).toBeNull();
  });

  test("arrows, Home and End move between rows, folder heads included", async ({ page }) => {
    await openLibrary(page);
    await songRow(page, JOB_ID).focus();
    const head = page.locator('#catalogList .folder[data-id="f-unsorted"] > .folder-head');

    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press(ROW_KEY.FIRST);
    await expect(head).toBeFocused();
    await page.keyboard.press(ROW_KEY.LAST);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press(ROW_KEY.PREVIOUS);
    await expect(songRow(page, JOB_ID)).toBeFocused();
    await page.keyboard.press(ROW_KEY.PREVIOUS);
    await expect(head).toBeFocused();

    await page.keyboard.press(ROW_KEY.OPEN);
    await expect(head.locator("..")).toHaveClass(/collapsed/);
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(head).toBeFocused();
    await page.keyboard.press(ROW_KEY.OPEN);
    await expect(head.locator("..")).not.toHaveClass(/collapsed/);
  });

  test("Enter opens the focused song and the row keeps focus", async ({ page }) => {
    await openLibrary(page);
    await songRow(page, SIBLING_JOB_ID).focus();
    await page.keyboard.press(ROW_KEY.OPEN);
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(ACTIVE, { timeout: OPEN_TIMEOUT_MS });
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
  });

  test("Right and Left walk the row's buttons, which stay out of the Tab order", async ({ page }) => {
    await openLibrary(page);
    const row = songRow(page, JOB_ID);
    await row.focus();

    await page.keyboard.press(ROW_KEY.INTO);
    await expect(row.locator(".cat-upnext")).toBeFocused();
    await page.keyboard.press(ROW_KEY.INTO);
    await expect(row.locator(".cat-more")).toBeFocused();
    await page.keyboard.press(ROW_KEY.INTO);
    const heart = row.locator(".cat-fav");
    await expect(heart).toBeFocused();
    const before = await heart.getAttribute("aria-pressed");
    const flipped = String(before !== "true");
    await page.keyboard.press(KEY.ENTER);
    await expect(heart).toHaveAttribute("aria-pressed", flipped);
    await expect(heart).toBeFocused();
    await page.keyboard.press(KEY.ENTER);
    await expect(heart).toHaveAttribute("aria-pressed", before);

    for (let i = 0; i < 3; i++) await page.keyboard.press(ROW_KEY.BACK);
    await expect(row).toBeFocused();
    await page.keyboard.press(ROW_KEY.INTO);
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
  });

  test("Delete bins the focused song and focus moves to the next one", async ({ page }) => {
    const { trash } = await openLibrary(page);
    await songRow(page, JOB_ID).focus();
    await page.keyboard.press(KEY.DELETE);

    await expect.poll(() => trash.calls).toEqual([trashCall(JOB_ID)]);
    expect(await trashItems(page)).toEqual([JOB_ID]);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();

    await page.keyboard.press(KEY.DELETE);
    await expect.poll(() => trash.calls).toEqual([trashCall(JOB_ID), trashCall(SIBLING_JOB_ID)]);
  });

  test("Delete after clicking a row bins nothing", async ({ page }) => {
    const { trash } = await openLibrary(page);
    await songRow(page, JOB_ID).click();
    await expect(songRow(page, JOB_ID)).toBeFocused();
    await page.keyboard.press(KEY.DELETE);

    await binSiblingByKeyboard(page, trash);
  });

  test("Delete after clicking a row and arrowing down bins the next song", async ({ page }) => {
    const { trash } = await openLibrary(page);
    await songRow(page, JOB_ID).click();
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.press(KEY.DELETE);

    await expect.poll(() => trash.calls).toEqual([trashCall(SIBLING_JOB_ID)]);
  });

  test("Delete after opening and closing the … menu with clicks bins nothing", async ({ page }) => {
    const { trash } = await openLibrary(page);
    const more = songRow(page, JOB_ID).locator(".cat-more");
    await songRow(page, JOB_ID).hover();
    await more.click();
    await expect(page.locator(".lib-menu")).toBeVisible();
    await more.click();
    await expect(page.locator(".lib-menu")).toHaveCount(0);
    await page.keyboard.press(KEY.DELETE);

    await binSiblingByKeyboard(page, trash);
  });
});

test.describe("touch", () => {
  test.use({ hasTouch: true });

  test("Delete after tapping a row bins nothing", async ({ page }) => {
    const { trash } = await openLibrary(page);
    await songRow(page, JOB_ID).tap();
    await expect(songRow(page, JOB_ID)).toBeFocused();
    await page.keyboard.press(KEY.DELETE);

    await binSiblingByKeyboard(page, trash);
  });
});

test.describe("other song lists", () => {
  test("Favourites rove the same way", async ({ page }) => {
    await openLibrary(page, { favorite: true });
    await page.locator(".rail-favorites").click();
    await expect(songRow(page, JOB_ID)).toBeVisible();
    expect(await rowTabStops(page, LIBRARY_ROWS)).toBe(1);

    await page.locator(`${SONG_ROW}[tabindex="0"]`).focus();
    await page.keyboard.press(ROW_KEY.LAST);
    await page.keyboard.press(ROW_KEY.FIRST);
    const first = await focusedRowKey(page);
    await page.keyboard.press(ROW_KEY.NEXT);
    expect(await focusedRowKey(page)).not.toBe(first);
    expect([JOB_ID, SIBLING_JOB_ID]).toContain(await focusedRowKey(page));
  });

  test("search results rove the same way", async ({ page }) => {
    await openLibrary(page);
    await page.locator("#catalogSearch").fill("Fixture");
    await expect(songRow(page, SIBLING_JOB_ID)).toBeVisible();
    expect(await rowTabStops(page, LIBRARY_ROWS)).toBe(1);

    await songRow(page, JOB_ID).focus();
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
  });

  test("the Trash is one Tab stop and a held Enter still restores", async ({ page }) => {
    const { trash } = await openLibrary(page, { trashed: [JOB_ID, SIBLING_JOB_ID] });
    await page.locator(".rail-trash").click();
    await expect(songRow(page, SIBLING_JOB_ID)).toBeVisible();
    expect(await rowTabStops(page, SONG_ROW)).toBe(1);

    await songRow(page, JOB_ID).focus();
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songRow(page, SIBLING_JOB_ID)).toBeFocused();
    await page.keyboard.down(KEY.ENTER);
    await page.waitForTimeout((await trashHoldMs(page)) * HOLD_PAST_RESTORE_FACTOR);
    await page.keyboard.up(KEY.ENTER);
    await expect.poll(() => trash.calls).toEqual([{ id: SIBLING_JOB_ID, action: "restore" }]);
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
    await page.keyboard.press(KEY.TAB);
    await expect(songs.first()).toBeFocused();
    await page.keyboard.press(ROW_KEY.PREVIOUS);
    await expect(page.locator(".setlist-head")).toBeFocused();
    await page.keyboard.press(ROW_KEY.INTO);
    await expect(page.locator(".setlist-play")).toBeFocused();

    await page.keyboard.press(ROW_KEY.NEXT);
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(songs.nth(1)).toBeFocused();
    await page.keyboard.press(ROW_KEY.INTO);
    await expect(songs.nth(1).locator(".setlist-song-up")).toBeFocused();
    await page.keyboard.press(ROW_KEY.BACK);
    await page.keyboard.press(ROW_KEY.OPEN);
    await expect(songRow(page, SIBLING_JOB_ID)).toHaveClass(ACTIVE, { timeout: OPEN_TIMEOUT_MS });
  });

  test("Delete on a setlist song bins nothing", async ({ page, request }) => {
    await request.post("/api/setlists", { data: { name: "Keys", song_ids: [JOB_ID] } });
    const { trash } = await openLibrary(page);
    await page.locator("#libTabSetlists").click();
    await page.locator(".setlist-song").focus();
    await page.keyboard.press(KEY.DELETE);
    await expect(page.locator(".setlist-song")).toHaveCount(1);

    await page.locator("#libTabSongs").click();
    await binSiblingByKeyboard(page, trash);
  });
});

test.describe("Up Next", () => {
  test("Up Next is one Tab stop; Enter plays a row and Right reaches its buttons", async ({ page }) => {
    await openLibrary(page);
    await page.evaluate(
      (ids) => {
        for (const id of ids) document.dispatchEvent(new CustomEvent("upnext:add", { detail: { id } }));
      },
      [JOB_ID, SIBLING_JOB_ID],
    );
    await openInspectorTab(page, "upnext");
    const rows = page.locator(UPNEXT_ROWS);
    await expect(rows).toHaveCount(2);
    expect(await rowTabStops(page, UPNEXT_ROWS)).toBe(1);

    await rows.first().focus();
    await page.keyboard.press(ROW_KEY.NEXT);
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press(ROW_KEY.INTO);
    await expect(rows.nth(1).locator(".upnext-play")).toBeFocused();
    await page.keyboard.press(ROW_KEY.INTO);
    await expect(rows.nth(1).locator(".upnext-remove")).toBeFocused();
    await page.keyboard.press(KEY.ENTER);
    await expect(rows).toHaveCount(1);

    await expect(rows.first()).toBeFocused();
    await page.keyboard.press(ROW_KEY.OPEN);
    await expect(songRow(page, JOB_ID)).toHaveClass(ACTIVE, { timeout: OPEN_TIMEOUT_MS });
  });
});
