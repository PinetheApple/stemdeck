// A song's … menu in Browse library moves it to any folder, or to a new one,
// the way dragging the row onto a folder does.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  KEY,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  openBrowse,
  readCatalogState,
  seedCatalogState,
  stubFavorites,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";

const UNSORTED = { id: "f-unsorted", name: "Unsorted" };
const REHEARSAL = { id: "f-rehearsal", name: "Rehearsal" };
const WARMUPS = { id: "f-warmups", name: "Warmups" };
const GIGS = { id: "f-gigs", name: "Gigs" };
const TREE_ORDER = [UNSORTED.name, REHEARSAL.name, WARMUPS.name, GIGS.name];
const NEW_FOLDER_NAME = "Covers";
const MAX_ARROW_PRESSES = 12;
const GERMAN = { moveToFolder: "In Ordner verschieben", newFolder: "Neuer Ordner…" };

async function openLibrary(page, { rehearsalCollapsed = false } = {}) {
  await seedCatalogState(page, {
    folders: [
      { ...UNSORTED, items: [JOB_ID], color: null },
      { ...REHEARSAL, items: [SIBLING_JOB_ID], color: null, collapsed: rehearsalCollapsed },
      { ...GIGS, items: [], color: null },
      // After Gigs in storage, so only a tree walk lists it under Rehearsal.
      { ...WARMUPS, items: [], color: null, parentId: REHEARSAL.id },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
  await stubFavorites(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openBrowse(page);
  await page.locator("#browseListBtn").click();
  await expect(rowOf(page, JOB_ID)).toBeVisible();
}

const rowOf = (page, id) => page.locator(`#browseResults .cat-item[data-id="${id}"]`);
const folderNav = (page, id) => page.locator(`#browseNav .browse-nav-folder[data-folder="${id}"]`);
const countOf = (page, id) => folderNav(page, id).locator(".browse-nav-count");
const folderItem = (menu, name) => menu.getByRole("menuitem", { name, exact: true });
const setLanguage = (page, code) => page.evaluate(async (c) => (await import("/js/i18n.js")).setLanguage(c), code);

async function openRowMenu(page, id) {
  const row = rowOf(page, id);
  await row.hover();
  await row.locator(".cat-more").click();
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** The folder items between the "Move to folder" label and "New folder…". */
async function folderItemNames(page, menu) {
  const label = await uiText(page, "trackMenu.moveToFolder");
  const newFolder = await uiText(page, "trackMenu.newFolder");
  const texts = await menu.locator(".lib-menu-label, .lib-menu-item").allTextContents();
  const start = texts.indexOf(label);
  expect(start).toBeGreaterThan(-1);
  return texts.slice(start + 1, texts.indexOf(newFolder, start));
}

async function expectMoved(page, trackId, to) {
  await expect(rowOf(page, trackId).locator(".c-folder")).toHaveText(to.name);
  const state = await readCatalogState(page);
  const holders = state.folders.filter((f) => f.items.includes(trackId)).map((f) => f.id);
  expect(holders).toEqual([to.id]);
}

const focusedText = (page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

async function arrowTo(page, name) {
  for (let i = 0; i < MAX_ARROW_PRESSES && (await focusedText(page)) !== name; i++) {
    await page.keyboard.press("ArrowDown");
  }
  expect(await focusedText(page)).toBe(name);
}

test("the menu lists every folder and subfolder, in tree order, then New folder…", async ({ page }) => {
  await openLibrary(page);
  const menu = await openRowMenu(page, JOB_ID);
  await expect(menu.locator(".lib-menu-label").filter({ hasText: await uiText(page, "trackMenu.moveToFolder") })).toBeVisible();
  expect(await folderItemNames(page, menu)).toEqual(TREE_ORDER);
  await expect(menu.locator(".lib-menu-item:not(.is-danger)").last()).toHaveText(await uiText(page, "trackMenu.newFolder"));
  await expect(folderItem(menu, "Trash")).toHaveCount(0);

  const indentOf = (name) => folderItem(menu, name).evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(await indentOf(WARMUPS.name)).toBeGreaterThan(await indentOf(REHEARSAL.name));
  expect(await indentOf(GIGS.name)).toBe(await indentOf(REHEARSAL.name));
});

test("the song's current folder is marked and cannot be picked", async ({ page }) => {
  await openLibrary(page);
  const menu = await openRowMenu(page, SIBLING_JOB_ID);
  const current = folderItem(menu, REHEARSAL.name);
  await expect(current).toBeDisabled();
  await expect(current).toHaveAttribute("aria-current", "true");
  for (const other of [UNSORTED, WARMUPS, GIGS]) {
    await expect(folderItem(menu, other.name)).toBeEnabled();
    await expect(folderItem(menu, other.name)).not.toHaveAttribute("aria-current", "true");
  }
});

test("picking a folder moves the song out of its old one and updates the counts", async ({ page }) => {
  await openLibrary(page);
  await expect(countOf(page, UNSORTED.id)).toHaveText("1");
  await expect(countOf(page, WARMUPS.id)).toHaveText("0");

  const menu = await openRowMenu(page, JOB_ID);
  await folderItem(menu, WARMUPS.name).click();
  await expect(menu).toBeHidden();
  await expectMoved(page, JOB_ID, WARMUPS);
  await expect(countOf(page, UNSORTED.id)).toHaveText("0");
  await expect(countOf(page, WARMUPS.id)).toHaveText("1");

  const again = await openRowMenu(page, JOB_ID);
  await folderItem(again, UNSORTED.name).click();
  await expectMoved(page, JOB_ID, UNSORTED);
});

test("New folder… creates a folder and moves the song into it", async ({ page }) => {
  await openLibrary(page);
  const menu = await openRowMenu(page, JOB_ID);
  await folderItem(menu, await uiText(page, "trackMenu.newFolder")).click();

  const dialog = page.locator(".folder-editor");
  await expect(dialog.locator(".folder-editor-head > span")).toHaveText(await uiText(page, "library.newFolder"));
  await dialog.locator(".folder-editor-name").fill(NEW_FOLDER_NAME);
  await dialog.locator(".folder-editor-save").click();
  await expect(dialog).toBeHidden();

  const created = page.locator("#browseNav .browse-nav-folder", { hasText: NEW_FOLDER_NAME });
  await expect(created.locator(".browse-nav-count")).toHaveText("1");
  await expect(rowOf(page, JOB_ID).locator(".c-folder")).toHaveText(NEW_FOLDER_NAME);
  await expect(countOf(page, UNSORTED.id)).toHaveText("0");
});

test("the keyboard opens the menu, arrows to a folder, picks it with Enter, and Esc closes", async ({ page }) => {
  await openLibrary(page);
  const more = rowOf(page, JOB_ID).locator(".cat-more");
  await more.focus();
  await page.keyboard.press(KEY.ENTER);
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();

  await arrowTo(page, GIGS.name);
  await page.keyboard.press(KEY.ENTER);
  await expect(menu).toBeHidden();
  await expectMoved(page, JOB_ID, GIGS);
  await expect(rowOf(page, JOB_ID)).toBeFocused();
  // Focus put back by the move is not the keyboard's, so Delete stays unarmed.
  await page.keyboard.press(KEY.DELETE);
  await expect(rowOf(page, JOB_ID)).toBeVisible();

  const moreAgain = rowOf(page, JOB_ID).locator(".cat-more");
  await moreAgain.focus();
  await page.keyboard.press(KEY.ENTER);
  await expect(menu).toBeVisible();
  await arrowTo(page, WARMUPS.name);
  await page.keyboard.press(KEY.ESCAPE);
  await expect(menu).toBeHidden();
  await expect(moreAgain).toBeFocused();
  await expectMoved(page, JOB_ID, GIGS);
});

test("a move into a folder hidden in a collapsed one keeps it collapsed and focus on the song", async ({ page }) => {
  await openLibrary(page, { rehearsalCollapsed: true });
  await expect(folderNav(page, WARMUPS.id)).toHaveCount(0);
  await rowOf(page, JOB_ID).locator(".cat-more").focus();
  await page.keyboard.press(KEY.ENTER);
  await arrowTo(page, WARMUPS.name);
  await page.keyboard.press(KEY.ENTER);
  await expect(page.locator(".lib-menu")).toBeHidden();
  await expectMoved(page, JOB_ID, WARMUPS);
  await expect(folderNav(page, WARMUPS.id)).toHaveCount(0);
  await expect(rowOf(page, JOB_ID)).toBeFocused();
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  test("tapping the menu and a folder moves the song", async ({ page }) => {
    await openLibrary(page);
    // With no hover, a row shows its actions once a tap has selected it.
    await rowOf(page, JOB_ID).locator(".cat-title").tap();
    await rowOf(page, JOB_ID).locator(".cat-more").tap();
    const menu = page.locator(".lib-menu");
    await expect(menu).toBeVisible();
    await folderItem(menu, GIGS.name).tap();
    await expect(menu).toBeHidden();
    await expectMoved(page, JOB_ID, GIGS);
  });
});

test("the section reads in the chosen language", async ({ page }) => {
  await openLibrary(page);
  await setLanguage(page, "de");
  const menu = await openRowMenu(page, JOB_ID);
  await expect(menu.locator(".lib-menu-label").filter({ hasText: GERMAN.moveToFolder })).toBeVisible();
  await expect(menu.locator(".lib-menu-item:not(.is-danger)").last()).toHaveText(GERMAN.newFolder);
});
