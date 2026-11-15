// A folder or subfolder takes a new name from the "Rename folder" dialog, opened by a
// double-click, F2 or its row's … menu. Unsorted keeps its name and changes colour only.
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
const OLD_UNSORTED_RENAME = "Old inbox";
const WHITESPACE_ONLY = "   ";
const RENAME_KEY = "F2";
const EDITOR = ".folder-editor";
const EDITOR_TITLE = `${EDITOR}-head > span`;
const MORE = ".f-more";
const MENU = ".lib-menu";
const UNPICKED_DOT = ".folder-color-dot:not(.active)";

async function openLibrary(page, { unsortedName = UNSORTED.name } = {}) {
  await seedCatalogState(page, {
    folders: [
      { ...UNSORTED, name: unsortedName, items: [JOB_ID], color: null },
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

async function storedFolder(page, id) {
  const state = await readCatalogState(page);
  return state.folders.find((f) => f.id === id);
}

const storedName = async (page, id) => (await storedFolder(page, id))?.name;

async function expectNameAfterReload(page, id, name) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(nameOf(page, id)).toHaveText(name);
  expect(await storedName(page, id)).toBe(name);
}

async function renameByDoubleClick(page, id, name) {
  await nameOf(page, id).dblclick();
  await expect(page.locator(EDITOR_TITLE)).toHaveText(await uiText(page, "folderEditor.renameTitle"));
  await page.locator(`${EDITOR}-name`).fill(name);
}

/** Pick a colour the folder does not have yet and save; returns the colour picked. */
async function saveOtherColor(page) {
  const dot = page.locator(UNPICKED_DOT).first();
  const color = await dot.getAttribute("data-color");
  await dot.click();
  await page.locator(`${EDITOR}-save`).click();
  await expect(page.locator(EDITOR)).toHaveCount(0);
  return color;
}

test("a folder renamed with Enter shows its new name at once and after a reload, and keeps focus", async ({ page }) => {
  await openLibrary(page);

  await renameByDoubleClick(page, REHEARSAL.id, RENAMED);
  await page.keyboard.press(KEY.ENTER);

  await expect(page.locator(EDITOR)).toHaveCount(0);
  await expect(nameOf(page, REHEARSAL.id)).toHaveText(RENAMED);
  await expect(headOf(page, REHEARSAL.id)).toBeFocused();
  await expectNameAfterReload(page, REHEARSAL.id, RENAMED);
});

test("a subfolder renamed with Save shows its new name at once and after a reload", async ({ page }) => {
  await openLibrary(page);

  await renameByDoubleClick(page, WARMUPS.id, RENAMED_SUBFOLDER);
  await page.locator(`${EDITOR}-save`).click();

  await expect(nameOf(page, WARMUPS.id)).toHaveText(RENAMED_SUBFOLDER);
  await expectNameAfterReload(page, WARMUPS.id, RENAMED_SUBFOLDER);
});

test("a folder's new colour is saved and survives a reload", async ({ page }) => {
  await openLibrary(page);

  await nameOf(page, REHEARSAL.id).dblclick();
  const color = await saveOtherColor(page);

  expect((await storedFolder(page, REHEARSAL.id)).color).toBe(color);
  await page.reload({ waitUntil: "domcontentloaded" });
  expect((await storedFolder(page, REHEARSAL.id)).color).toBe(color);
  await expect
    .poll(() => headOf(page, REHEARSAL.id).evaluate((el) => el.style.getPropertyValue("--folder-color")))
    .toBe(color);
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
  await expect(page.locator(EDITOR_TITLE)).toHaveText(await uiText(page, "folderEditor.renameTitle"));
  await page.keyboard.type(RENAMED);
  await page.keyboard.press(KEY.ENTER);

  await expect(nameOf(page, REHEARSAL.id)).toHaveText(RENAMED);
  expect(await storedName(page, REHEARSAL.id)).toBe(RENAMED);
});

test("Unsorted's double-click edits its colour only, and F2 opens nothing", async ({ page }) => {
  await openLibrary(page);

  await nameOf(page, UNSORTED.id).dblclick();
  await expect(page.locator(EDITOR_TITLE)).toHaveText(await uiText(page, "folderEditor.title"));
  await expect(page.locator(`${EDITOR}-name`)).toHaveCount(0);
  const color = await saveOtherColor(page);

  const unsorted = await storedFolder(page, UNSORTED.id);
  expect(unsorted.color).toBe(color);
  expect(unsorted.name).toBe(UNSORTED.name);
  await headOf(page, UNSORTED.id).focus();
  await page.keyboard.press(RENAME_KEY);
  await expect(page.locator(EDITOR)).toHaveCount(0);
});

test("an Unsorted renamed by an older build still reads Unsorted, in the app's language", async ({ page }) => {
  await openLibrary(page, { unsortedName: OLD_UNSORTED_RENAME });

  await expect(nameOf(page, UNSORTED.id)).toHaveText(await uiText(page, "folder.unsorted"));
});

async function openFolderMenuByKeyboard(page, id) {
  await headOf(page, id).focus();
  await page.keyboard.press(ROW_KEY.INTO);
  await expect(headOf(page, id).locator(MORE)).toBeFocused();
  await page.keyboard.press(KEY.ENTER);
  const menu = page.locator(MENU);
  await expect(menu).toBeVisible();
  return menu;
}

async function chooseRename(page, menu) {
  const rename = menu.getByRole("menuitem", { name: await uiText(page, "trackMenu.rename"), exact: true });
  await expect(rename).toBeFocused();
  await page.keyboard.press(KEY.ENTER);
  await expect(page.locator(EDITOR_TITLE)).toHaveText(await uiText(page, "folderEditor.renameTitle"));
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
  await chooseRename(page, page.locator(MENU));
  await page.keyboard.type(RENAMED);
  await page.keyboard.press(KEY.ESCAPE);

  await expect(page.locator(EDITOR)).toHaveCount(0);
  await expect(nameOf(page, REHEARSAL.id)).toHaveText(REHEARSAL.name);
  expect(await storedName(page, REHEARSAL.id)).toBe(REHEARSAL.name);
});

test("Escape on the … menu closes it and gives focus back to the … button", async ({ page }) => {
  await openLibrary(page);

  await openFolderMenuByKeyboard(page, REHEARSAL.id);
  await page.keyboard.press(KEY.ESCAPE);

  await expect(page.locator(MENU)).toHaveCount(0);
  await expect(headOf(page, REHEARSAL.id).locator(MORE)).toBeFocused();
});

test("the … menu's Delete, by keyboard, arms the … button and a second Enter deletes", async ({ page }) => {
  await openLibrary(page);

  const menu = await openFolderMenuByKeyboard(page, WARMUPS.id);
  await page.keyboard.press(ROW_KEY.PREVIOUS);
  await expect(menu.getByRole("menuitem", { name: await uiText(page, "folder.deleteFolder") })).toBeFocused();
  await page.keyboard.press(KEY.ENTER);

  const more = headOf(page, WARMUPS.id).locator(MORE);
  await expect(more).toHaveAttribute("data-armed", "1");
  await expect(more).toBeFocused();
  await page.keyboard.press(KEY.ENTER);

  await expect(page.locator(`#catalogList .folder[data-id="${WARMUPS.id}"]`)).toHaveCount(0);
  expect(await storedFolder(page, WARMUPS.id)).toBeUndefined();
});

test("the … menu's New subfolder adds a named folder inside this one", async ({ page }) => {
  await openLibrary(page);

  const menu = await openFolderMenuByKeyboard(page, REHEARSAL.id);
  await menu.getByRole("menuitem", { name: await uiText(page, "folder.newSubfolder"), exact: true }).click();
  await expect(page.locator(EDITOR_TITLE)).toHaveText(await uiText(page, "folder.newSubfolder"));
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
