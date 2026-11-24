// Trash, restore, Empty trash, a new setlist and the phone's heart and Trash, refused
// while StemData moves: each is undone and says to wait for the move (#190).
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  failureMessages,
  fixtureTrack,
  openStudio,
  readCatalogState,
  seedCatalogState,
  stubFavorites,
  stubServerTrash,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";
import { EDIT_FOLDER_MOVING_DETAIL, FOLDER_MOVING_KEY } from "../../static/js/folderMoving.js";
import { HTTP_CONFLICT } from "../../static/js/lyricsTranscribe.js";

const TRASH_OR_RESTORE = /\/api\/jobs\/[a-f0-9]{12}\/(trash|restore)$/;
const JOB_URL = /\/api\/jobs\/[a-f0-9]{12}$/;
const RESTORE_HOLD_MS = 1300;

const refuse = (route) => route.fulfill({
  status: HTTP_CONFLICT,
  contentType: "application/json",
  body: JSON.stringify({ detail: EDIT_FOLDER_MOVING_DETAIL }),
});

function refuseDeletes(route) {
  return route.request().method() === "DELETE" ? refuse(route) : route.fallback();
}

const DOOMED_FOLDER = "f-doomed";

/** The library with `trashed` in the Trash and `inFolder` in a folder of their own; the rest unsorted. */
async function openLibrary(page, trashed, inFolder = []) {
  const unsorted = [JOB_ID, SIBLING_JOB_ID].filter((id) => id !== trashed && !inFolder.includes(id));
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: unsorted, color: null },
      { id: DOOMED_FOLDER, name: "Doomed", items: inFolder, color: null },
      { id: "trash", name: "Trash", items: trashed ? [trashed] : [], color: null },
    ],
    tracks: { [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE), [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE) },
  });
  await stubUpdateCheck(page);
  await stubServerTrash(page, { trashed: trashed ? [trashed] : [] });
  await page.route(TRASH_OR_RESTORE, refuse);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first()).toBeAttached();
  return uiText(page, FOLDER_MOVING_KEY);
}

const trashItems = async (page) => (await readCatalogState(page))?.folders.find((f) => f.id === "trash")?.items ?? [];

test.describe("studio", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("a song binned during the move comes back and says to wait for it", async ({ page }) => {
    const moving = await openLibrary(page, null);

    await page.locator(`.cat-item[data-id="${JOB_ID}"] .cat-fav`).first().focus();
    await page.keyboard.press("Delete");

    await expect.poll(() => failureMessages(page)).toEqual([moving]);
    expect(await trashItems(page)).toEqual([]);
    await expect(page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first()).toBeVisible();
  });

  test("the open song binned from a folder during the move is back in its place, still open", async ({ page }) => {
    const live = { id: "f-live", name: "Live", items: [SIBLING_JOB_ID, JOB_ID], color: null };
    await openStudio(page, {
      catalog: {
        folders: [{ id: "f-unsorted", name: "Unsorted", items: [], color: null }, live, { id: "trash", name: "Trash", items: [], color: null }],
        tracks: { [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE), [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE) },
      },
    });
    await page.route(TRASH_OR_RESTORE, refuse);
    const moving = await uiText(page, FOLDER_MOVING_KEY);
    const row = page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first();
    await expect(row).toHaveClass(/\bactive\b/);

    await row.hover();
    await row.locator(".cat-del").click();

    await expect.poll(() => failureMessages(page)).toEqual([moving]);
    const folders = (await readCatalogState(page))?.folders ?? [];
    expect(folders.find((f) => f.id === live.id)?.items).toEqual(live.items);
    expect(await trashItems(page)).toEqual([]);
    await expect(row).toHaveClass(/\bactive\b/);
  });

  test("a song opened while its refused trash was on the way stays the open one", async ({ page }) => {
    await openStudio(page);
    let answer;
    const answered = new Promise((resolve) => (answer = resolve));
    await page.route(TRASH_OR_RESTORE, async (route) => {
      await answered;
      await refuse(route);
    });
    const binned = page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first();
    const opened = page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`).first();

    await binned.hover();
    await binned.locator(".cat-del").click();
    await opened.dblclick();
    await expect(opened).toHaveClass(/\bactive\b/);
    answer();

    await expect.poll(() => failureMessages(page)).toEqual([await uiText(page, FOLDER_MOVING_KEY)]);
    await expect(binned).toBeVisible();
    await expect(opened).toHaveClass(/\bactive\b/);
    await expect(binned).not.toHaveClass(/\bactive\b/);
  });

  test("songs of a folder deleted during the move come back to the library", async ({ page }) => {
    const moving = await openLibrary(page, null, [JOB_ID, SIBLING_JOB_ID]);
    const doomed = page.locator(`.folder[data-id="${DOOMED_FOLDER}"] > .folder-head`);
    const more = doomed.locator(".f-more");
    await doomed.hover();
    await more.click();
    await page.locator(".lib-menu").getByRole("menuitem", { name: await uiText(page, "folder.deleteFolder") }).click();
    await more.click();

    await expect.poll(() => failureMessages(page)).toEqual([moving]);
    expect(await trashItems(page)).toEqual([]);
    const folders = (await readCatalogState(page))?.folders ?? [];
    expect(folders.find((f) => f.id === "f-unsorted")?.items.sort()).toEqual([JOB_ID, SIBLING_JOB_ID].sort());
  });

  test("a song restored during the move goes back to the Trash and says to wait for it", async ({ page }) => {
    const moving = await openLibrary(page, JOB_ID);
    await page.locator(".lib-nav-trash").click();
    const row = page.locator(`#catalogList .cat-item.in-trash[data-id="${JOB_ID}"]`);
    const box = await row.boundingBox();

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(RESTORE_HOLD_MS);
    await page.mouse.up();

    await expect.poll(() => failureMessages(page)).toEqual([moving]);
    expect(await trashItems(page)).toEqual([JOB_ID]);
  });

  test("Empty trash refused for the move keeps the songs and says to wait for it", async ({ page }) => {
    const moving = await openLibrary(page, JOB_ID);
    await page.route(JOB_URL, refuseDeletes);
    await page.locator(".lib-nav-trash").click();

    await page.locator("#clearBinBtn").click();
    await page.locator("#clearBinBtn").click();

    await expect.poll(() => failureMessages(page)).toEqual([moving]);
    expect(await trashItems(page)).toEqual([JOB_ID]);
  });

  test("a setlist made during the move says to wait for it", async ({ page }) => {
    await openStudio(page);
    await page.route("**/api/setlists", (route) => (route.request().method() === "POST" ? refuse(route) : route.fallback()));
    await page.locator("#libTabSetlists").click();

    await page.locator("#setlistNewBtn").click();
    await page.locator(".setlist-name-input").fill("Sunday");
    await page.locator(".setlist-name-input").press("Enter");

    await expect(page.locator("#setlistsError")).toHaveText(await uiText(page, FOLDER_MOVING_KEY));
    await expect(page.locator(".setlist")).toHaveCount(0);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function openPhone(page) {
    await stubFavorites(page, {});
    await page.goto("/?ui=mobile", { waitUntil: "domcontentloaded" });
    await page.locator('[data-action="tab"][data-tab="library"]').first().click();
    await page.locator(`.track[data-id="${SIBLING_JOB_ID}"]`).first().waitFor({ timeout: 20000 });
    return uiText(page, FOLDER_MOVING_KEY);
  }

  test("a heart refused for the move is taken back and says to wait for it", async ({ page }) => {
    const moving = await openPhone(page);
    await page.route("**/api/jobs/*/favorite", refuse);
    const heart = page.locator(`.track-fav[data-id="${SIBLING_JOB_ID}"]`);

    await heart.click();

    await expect(page.locator("#m-toast")).toHaveText(moving);
    await expect(heart).toHaveAttribute("aria-pressed", "false");
  });

  test("a song sent to the Trash during the move stays and says to wait for it", async ({ page }) => {
    const moving = await openPhone(page);
    await page.route(TRASH_OR_RESTORE, refuse);

    await page.locator(`.track-delete[data-id="${SIBLING_JOB_ID}"]`).dispatchEvent("click");

    await expect(page.locator("#m-toast")).toHaveText(moving);
    await expect(page.locator(`.track[data-id="${SIBLING_JOB_ID}"]`).first()).toBeVisible();
  });
});
