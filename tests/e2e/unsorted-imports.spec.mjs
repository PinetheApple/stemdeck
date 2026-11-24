// A new import lands in Unsorted whatever order the folders are in, a song link that
// names its playlist imports one song, and a folder deleted in one tab stays deleted
// when another tab with the old folder list saves (#228).
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  readCatalogState,
  seedCatalogState,
  stubUpdateCheck,
  uiText, openComposer } from "./helpers.mjs";
import { YT, review, stubImports, stubPreview } from "./batchImport.mjs";

const UNSORTED_ID = "f-unsorted";
const SUNDAY = { id: "f-sunday", name: "Oct 25 Sunday" };
const NEW_JOB_ID = "e2e0b0000001";
const SONG_LINK = `${YT}eeeeeeeeeee`;
const SONG_IN_PLAYLIST_LINK = `${SONG_LINK}&list=PLsundayset&index=3`;
const TOP_EDGE_PX = 2;

const folderEl = (page, id) => page.locator(`.folder[data-id="${id}"]`);
const folderHead = (page, id) => folderEl(page, id).locator(":scope > .folder-head");
const storedFolders = async (page) => (await readCatalogState(page))?.folders ?? [];
const storedFolder = async (page, id) => (await storedFolders(page)).find((f) => f.id === id);

async function seedWithSunday(page, { seedOnce = false } = {}) {
  await seedCatalogState(page, {
    folders: [
      { id: UNSORTED_ID, name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null, parentId: null },
      { ...SUNDAY, items: [], color: null, parentId: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: { [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE), [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE) },
    seedOnce,
  });
}

async function openLibrary(page) {
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(folderEl(page, SUNDAY.id)).toBeVisible();
}

/** Drop `draggedId`'s grip on the top edge of `targetId`'s row, which reorders it before that folder. */
async function dragFolderAbove(page, draggedId, targetId) {
  await page.evaluate(({ draggedId, targetId, edge }) => {
    const grip = document.querySelector(`.folder[data-id="${draggedId}"] > .folder-head .f-grip`);
    const target = document.querySelector(`.folder[data-id="${targetId}"]`);
    const head = target.querySelector(":scope > .folder-head").getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    const at = { bubbles: true, cancelable: true, dataTransfer, clientX: head.left + edge, clientY: head.top + edge };
    grip.dispatchEvent(new DragEvent("dragstart", at));
    target.dispatchEvent(new DragEvent("dragover", at));
    target.dispatchEvent(new DragEvent("drop", at));
    grip.dispatchEvent(new DragEvent("dragend", at));
  }, { draggedId, targetId, edge: TOP_EDGE_PX });
}

async function importLink(page, link) {
  await openComposer(page);
  await page.locator("#url").fill(link);
  await page.locator("#submit").click();
}

test.describe("new imports go to Unsorted (#228)", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("a link lands in Unsorted after a folder was dragged above it", async ({ page }) => {
    await seedWithSunday(page);
    await openLibrary(page);
    await dragFolderAbove(page, SUNDAY.id, UNSORTED_ID);
    await expect.poll(async () => (await storedFolders(page)).map((f) => f.id)).toEqual([SUNDAY.id, UNSORTED_ID, "trash"]);

    const posts = await stubImports(page);
    await importLink(page, SONG_LINK);
    await expect.poll(() => posts.length).toBe(1);
    await expect.poll(async () => (await storedFolder(page, UNSORTED_ID))?.items[0]).toBe(NEW_JOB_ID);
    expect((await storedFolder(page, SUNDAY.id)).items).toEqual([]);
  });

  test("a song link that names its playlist imports that one song, with no review and no folder", async ({ page }) => {
    await seedWithSunday(page);
    await openLibrary(page);
    const asked = await stubPreview(page, { items: [], playlists: [], files: [] });
    const posts = await stubImports(page);
    await expect(page.locator("#submit")).toHaveText(await uiText(page, "process.extractStems"));

    await importLink(page, SONG_IN_PLAYLIST_LINK);
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0].url).toBe(SONG_IN_PLAYLIST_LINK);
    expect(asked).toEqual([]);
    await expect(review(page)).toHaveCount(0);
    await expect.poll(async () => (await storedFolder(page, UNSORTED_ID))?.items[0]).toBe(NEW_JOB_ID);
    expect((await storedFolders(page)).map((f) => f.id)).toEqual([UNSORTED_ID, SUNDAY.id, "trash"]);
  });

  test("a folder deleted in one tab stays deleted after a stale tab saves", async ({ page, context }) => {
    await seedWithSunday(page, { seedOnce: true });
    await openLibrary(page);
    const stale = await context.newPage();
    await openLibrary(stale);

    await folderHead(page, SUNDAY.id).hover();
    await folderHead(page, SUNDAY.id).locator(".f-more").click();
    await page.locator(".lib-menu").getByRole("menuitem", { name: await uiText(page, "folder.deleteFolder") }).click();
    await folderHead(page, SUNDAY.id).locator(".f-more").click();
    await expect(folderEl(page, SUNDAY.id)).toHaveCount(0);

    await expect(folderEl(stale, SUNDAY.id)).toHaveCount(0);
    await folderHead(stale, UNSORTED_ID).locator(".f-name").click();
    await expect.poll(async () => (await storedFolder(stale, UNSORTED_ID))?.collapsed).toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(folderEl(page, UNSORTED_ID)).toBeVisible();
    await expect(folderEl(page, SUNDAY.id)).toHaveCount(0);
    expect(await storedFolder(page, SUNDAY.id)).toBeUndefined();
  });
});
