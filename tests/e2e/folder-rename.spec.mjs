// A folder or subfolder takes a new name from the folder editor, opened by a
// double-click, F2 or its row's … menu; Unsorted and Trash keep theirs.
import { test, expect } from "@playwright/test";
import { ROW_KEY } from "../../static/js/rovingRows.js";
import {
  JOB_ID,
  KEY,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  readCatalogState,
  seedCatalogState,
  stubFavorites,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";

const UNSORTED = { id: "f-unsorted", name: "Unsorted" };
const REHEARSAL = { id: "f-rehearsal", name: "Rehearsal" };
const WARMUPS = { id: "f-warmups", name: "Warmups" };
const TRASH = { id: "trash", name: "Trash" };
const RENAMED = "Gig night";
const RENAMED_SUBFOLDER = "Scales";
const WHITESPACE_ONLY = "   ";
const RENAME_KEY = "F2";
const EDITOR = ".folder-editor";
const MORE = ".f-more";

async function openLibrary(page) {
  await seedCatalogState(page, {
    folders: [
      { ...UNSORTED, items: [JOB_ID], color: null },
      { ...REHEARSAL, items: [SIBLING_JOB_ID], color: null },
      { ...WARMUPS, items: [], color: null, parentId: REHEARSAL.id },
      { ...TRASH, items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
    seedOnce: true,
  });
  await stubFavorites(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first()).toBeVisible();
}

const headOf = (page, id) => page.locator(`#catalogList .folder[data-id="${id}"] > .folder-head`);
const nameOf = (page, id) => headOf(page, id).locator(".f-name");

async function storedName(page, id) {
  const state = await readCatalogState(page);
  return state.folders.find((f) => f.id === id)?.name;
}

async function expectNameAfterReload(page, id, name) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(nameOf(page, id)).toHaveText(name);
  expect(await storedName(page, id)).toBe(name);
}

async function renameByDoubleClick(page, id, name) {
  await nameOf(page, id).dblclick();
  await page.locator(`${EDITOR}-name`).fill(name);
}

test("a folder renamed with Enter shows its new name at once and after a reload", async ({ page }) => {
  await openLibrary(page);

  await renameByDoubleClick(page, REHEARSAL.id, RENAMED);
  await page.keyboard.press(KEY.ENTER);

  await expect(page.locator(EDITOR)).toHaveCount(0);
  await expect(nameOf(page, REHEARSAL.id)).toHaveText(RENAMED);
  await expectNameAfterReload(page, REHEARSAL.id, RENAMED);
});

test("a subfolder renamed with Save shows its new name at once and after a reload", async ({ page }) => {
  await openLibrary(page);

  await renameByDoubleClick(page, WARMUPS.id, RENAMED_SUBFOLDER);
  await page.locator(`${EDITOR}-save`).click();

  await expect(nameOf(page, WARMUPS.id)).toHaveText(RENAMED_SUBFOLDER);
  await expectNameAfterReload(page, WARMUPS.id, RENAMED_SUBFOLDER);
});

test("a whitespace-only name is refused with a message and the old name stays", async ({ page }) => {
  await openLibrary(page);

  await renameByDoubleClick(page, REHEARSAL.id, WHITESPACE_ONLY);
  await page.keyboard.press(KEY.ENTER);

  await expect(page.locator(`${EDITOR}-msg`)).toHaveText(await uiText(page, "folderEditor.emptyError"));
  await expect(page.locator(EDITOR)).toHaveCount(1);
  await page.keyboard.press(KEY.ESCAPE);
  await expect(nameOf(page, REHEARSAL.id)).toHaveText(REHEARSAL.name);
  await expectNameAfterReload(page, REHEARSAL.id, REHEARSAL.name);
});

test("Escape closes the editor and keeps the old name", async ({ page }) => {
  await openLibrary(page);

  await renameByDoubleClick(page, REHEARSAL.id, RENAMED);
  await page.keyboard.press(KEY.ESCAPE);

  await expect(page.locator(EDITOR)).toHaveCount(0);
  await expect(nameOf(page, REHEARSAL.id)).toHaveText(REHEARSAL.name);
  expect(await storedName(page, REHEARSAL.id)).toBe(REHEARSAL.name);
});

test("F2 on a focused folder row opens the editor and Enter saves the name", async ({ page }) => {
  await openLibrary(page);

  await headOf(page, REHEARSAL.id).focus();
  await page.keyboard.press(RENAME_KEY);
  await expect(page.locator(`${EDITOR}-name`)).toBeFocused();
  await expect(page.locator(`${EDITOR}-head > span`)).toHaveText(await uiText(page, "folderEditor.renameTitle"));
  await page.keyboard.type(RENAMED);
  await page.keyboard.press(KEY.ENTER);

  await expect(nameOf(page, REHEARSAL.id)).toHaveText(RENAMED);
  expect(await storedName(page, REHEARSAL.id)).toBe(RENAMED);
});

test("Unsorted opens no editor by double-click or F2", async ({ page }) => {
  await openLibrary(page);

  await nameOf(page, UNSORTED.id).dblclick();
  await expect(page.locator(EDITOR)).toHaveCount(0);
  await headOf(page, UNSORTED.id).focus();
  await page.keyboard.press(RENAME_KEY);
  await expect(page.locator(EDITOR)).toHaveCount(0);

  await nameOf(page, REHEARSAL.id).dblclick();
  await expect(page.locator(EDITOR)).toHaveCount(1);
});

async function openFolderMenuByKeyboard(page, id) {
  await headOf(page, id).focus();
  await page.keyboard.press(ROW_KEY.INTO);
  await expect(headOf(page, id).locator(MORE)).toBeFocused();
  await page.keyboard.press(KEY.ENTER);
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();
  return menu;
}

async function chooseRename(page, menu) {
  const rename = menu.getByRole("menuitem", { name: await uiText(page, "trackMenu.rename"), exact: true });
  await expect(rename).toBeFocused();
  await page.keyboard.press(KEY.ENTER);
  await expect(page.locator(`${EDITOR}-head > span`)).toHaveText(await uiText(page, "folderEditor.renameTitle"));
}

test("the … menu's Rename, reached by keyboard, saves the new name with Enter", async ({ page }) => {
  await openLibrary(page);

  await chooseRename(page, await openFolderMenuByKeyboard(page, WARMUPS.id));
  await page.keyboard.type(RENAMED_SUBFOLDER);
  await page.keyboard.press(KEY.ENTER);

  await expect(nameOf(page, WARMUPS.id)).toHaveText(RENAMED_SUBFOLDER);
  await expectNameAfterReload(page, WARMUPS.id, RENAMED_SUBFOLDER);
});

test("the … menu's Rename, opened by a click, is cancelled by Escape", async ({ page }) => {
  await openLibrary(page);

  await headOf(page, REHEARSAL.id).hover();
  await headOf(page, REHEARSAL.id).locator(MORE).click();
  await chooseRename(page, page.locator(".lib-menu"));
  await page.keyboard.type(RENAMED);
  await page.keyboard.press(KEY.ESCAPE);

  await expect(page.locator(EDITOR)).toHaveCount(0);
  await expect(nameOf(page, REHEARSAL.id)).toHaveText(REHEARSAL.name);
  expect(await storedName(page, REHEARSAL.id)).toBe(REHEARSAL.name);
});

test("the … menu's New subfolder adds a named folder inside this one", async ({ page }) => {
  await openLibrary(page);

  const menu = await openFolderMenuByKeyboard(page, REHEARSAL.id);
  await menu.getByRole("menuitem", { name: await uiText(page, "folder.newSubfolder"), exact: true }).click();
  await expect(page.locator(`${EDITOR}-head > span`)).toHaveText(await uiText(page, "folder.newSubfolder"));
  await page.keyboard.type(RENAMED_SUBFOLDER);
  await page.keyboard.press(KEY.ENTER);

  const child = page.locator(`#catalogList .folder[data-id="${REHEARSAL.id}"] .folder .f-name`, { hasText: RENAMED_SUBFOLDER });
  await expect(child).toBeVisible();
  const state = await readCatalogState(page);
  expect(state.folders.find((f) => f.name === RENAMED_SUBFOLDER)?.parentId).toBe(REHEARSAL.id);
});

test("Unsorted's row has no … menu, while a user folder's row has one", async ({ page }) => {
  await openLibrary(page);

  await expect(headOf(page, REHEARSAL.id).locator(MORE)).toHaveCount(1);
  await expect(headOf(page, UNSORTED.id).locator(MORE)).toHaveCount(0);
});

test("Trash has no folder row to rename, in the library or the Trash view", async ({ page }) => {
  await openLibrary(page);
  await expect(headOf(page, REHEARSAL.id)).toBeVisible();
  await expect(headOf(page, TRASH.id)).toHaveCount(0);

  await page.locator(".rail-trash").click();
  await expect(page.locator(".rail-trash")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#catalogList .folder-head")).toHaveCount(0);
});
