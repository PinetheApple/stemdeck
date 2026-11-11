// The library pane's finish: counts that follow the search, one empty-state
// look, rail labels that fit and say what each entry is, dialog titles that
// match the action, row menus and icons that leave the rows readable, and a
// main area that says how to start when no song is open.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  TRACK_TITLE,
  fixtureTrack,
  SIBLING_TITLE,
  openStudio,
  seedCatalogState,
  seedLibrary,
  stubFavorites,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";

const EMPTY_FOLDER_ID = "f-empty";
const NO_MATCH_QUERY = "zzzz-no-such-song";
const LANGUAGES = ["en", "pl", "ja", "ko", "zh-Hans", "de", "fr", "es", "pt", "pt-PT", "id"];

/** The library without opening a song, so the empty main area stays up. */
async function openLibrary(page, { emptyFolder = false } = {}) {
  if (emptyFolder) await seedWithEmptyFolder(page);
  else await seedLibrary(page);
  await stubFavorites(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`.cat-item[data-id="${JOB_ID}"]`)).toBeVisible();
}

async function seedWithEmptyFolder(page) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: EMPTY_FOLDER_ID, name: "Rehearsal", items: [], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
}

async function search(page, query) {
  await page.locator("#catalogSearch").fill(query);
}

/** An empty list says so with the Setlists look: an icon, a heading and a hint. */
async function expectEmptyState(page, headingKey, hintKey) {
  const empty = page.locator("#catalogList .lib-empty");
  await expect(empty).toHaveCount(1);
  await expect(empty.locator("svg")).toBeVisible();
  await expect(empty.locator("strong")).toHaveText(await uiText(page, headingKey));
  await expect(empty.locator(".lib-empty-hint")).toHaveText(await uiText(page, hintKey));
  await expect(page.locator("#catalogList .folder-empty")).toHaveCount(0);
}

const LOOK_PROPS = ["display", "flexDirection", "alignItems", "gap", "padding", "textAlign", "color", "fontSize"];

/** The styles that make an empty state look like one, for it, its icon and its heading. */
const lookOf = (locator) => locator.evaluate((el, props) => {
  const pick = (node) => props.map((prop) => getComputedStyle(node)[prop]);
  const icon = getComputedStyle(el.querySelector("svg"));
  return { box: pick(el), heading: pick(el.querySelector("strong")), icon: [icon.width, icon.height] };
}, LOOK_PROPS);

const boxOf = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
});

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test("the Songs count is the number of songs the search leaves", async ({ page }) => {
  await openLibrary(page);
  const count = page.locator("#libSongsCount");
  await expect(count).toHaveText("2");

  await search(page, "again");
  await expect(page.locator("#catalogList .cat-item")).toHaveCount(1);
  await expect(count).toHaveText("1");

  await search(page, NO_MATCH_QUERY);
  await expect(count).toHaveText("0");

  await search(page, "");
  await expect(count).toHaveText("2");
});

test("Trash, Favorites and a search with no match share one empty state", async ({ page }) => {
  await openLibrary(page);
  await search(page, NO_MATCH_QUERY);
  await expectEmptyState(page, "library.noSearchMatch", "search.noMatchHint");

  await search(page, "");
  await page.locator(".rail-trash").click();
  await expectEmptyState(page, "trash.isEmptyState", "trash.emptyHint");

  await page.locator(".rail-favorites").click();
  await expectEmptyState(page, "favorites.emptyTitle", "favorites.emptyHint");
  await search(page, NO_MATCH_QUERY);
  await expectEmptyState(page, "favorites.noSearchMatch", "search.noMatchHint");
});

test("the empty states look like the Setlists one", async ({ page }) => {
  await openLibrary(page);
  await page.locator(".rail-trash").click();
  const trashLook = await lookOf(page.locator("#catalogList .lib-empty"));
  await page.locator(".rail-library").click();
  await page.locator("#libTabSetlists").click();
  expect(trashLook).toEqual(await lookOf(page.locator("#setlistsEmpty")));
});

test("an empty folder says so in the app's language", async ({ page }) => {
  await openLibrary(page, { emptyFolder: true });
  const folder = page.locator(`.folder[data-id="${EMPTY_FOLDER_ID}"]`);
  await expect(folder.locator(".folder-empty")).toHaveText(await uiText(page, "library.emptyFolder"));
});

test("every rail label fits its button, in every language", async ({ page }) => {
  await openLibrary(page);
  for (const code of LANGUAGES) {
    await page.evaluate(async (c) => (await import("/js/i18n.js")).setLanguage(c), code);
    const cut = await page.evaluate(() => [...document.querySelectorAll(".sidebar-rail .rail-btn > span[data-i18n]")]
      .filter((label) => label.offsetParent)
      .filter((label) => {
        const box = label.getBoundingClientRect();
        const button = label.closest(".rail-btn").getBoundingClientRect();
        return label.scrollWidth > label.clientWidth || box.left < button.left || box.right > button.right;
      })
      .map((label) => label.textContent));
    expect(cut, `cut short in ${code}`).toEqual([]);
  }
});

test("Guide and About are told apart by label and tooltip, and do different things", async ({ page }) => {
  await openLibrary(page);
  const guide = page.locator("#helpModeBtn");
  const about = page.locator("#aboutBtn");
  await expect(about.locator("span")).toHaveText(await uiText(page, "nav.about"));
  await expect(about).toHaveAttribute("title", await uiText(page, "nav.aboutTitle"));
  await expect(about).toHaveAccessibleName(await uiText(page, "nav.aboutTitle"));
  expect(await guide.locator("span").textContent()).not.toBe(await about.locator("span").textContent());
  expect(await guide.getAttribute("title")).not.toBe(await about.getAttribute("title"));

  await about.click();
  await expect(page.locator("#aboutDialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await guide.click();
  await expect(guide).toHaveAttribute("aria-pressed", "true");
});

test("New folder opens a dialog titled New folder; editing one says Edit folder", async ({ page }) => {
  await openLibrary(page);
  await page.locator("#newFolderBtn").click();
  const dialog = page.locator(".folder-editor");
  const newTitle = await uiText(page, "library.newFolder");
  await expect(dialog.locator(".folder-editor-head > span")).toHaveText(newTitle);
  await expect(dialog).toHaveAttribute("aria-label", newTitle);
  await dialog.locator(".folder-editor-cancel").click();

  await page.locator('.folder[data-id="f-unsorted"] > .folder-head .f-name').dblclick();
  await expect(dialog.locator(".folder-editor-head > span")).toHaveText(await uiText(page, "folderEditor.title"));
});

test("the row menu opens beside the row and covers none of the list", async ({ page }) => {
  await openLibrary(page);
  const row = page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`);
  await row.hover();
  await row.locator(".cat-more").click();
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();
  const menuBox = await boxOf(menu);
  for (const item of await page.locator("#catalogList .cat-item").all()) {
    expect(overlaps(menuBox, await boxOf(item)), "menu covers a row").toBe(false);
  }
  const rowBox = await boxOf(row);
  expect(Math.abs(menuBox.top - rowBox.top)).toBeLessThanOrEqual(1);
});

test("the open song's actions leave its title and artist uncovered", async ({ page }) => {
  await openStudio(page);
  const row = page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`);
  await row.click();
  await page.mouse.move(0, 0);
  await expect(row).toHaveClass(/\bactive\b/);
  const actions = row.locator(".cat-actions");
  await expect.poll(() => actions.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  const meta = await boxOf(row.locator(".cat-meta"));
  const actionsBox = await boxOf(actions);
  expect(meta.right).toBeLessThanOrEqual(actionsBox.left);
});

test("with no song open the main area says how to start", async ({ page }) => {
  await openLibrary(page);
  const start = page.locator("#emptyStart");
  await expect(start).toBeVisible();
  await expect(start.locator("strong")).toHaveText(await uiText(page, "start.title"));

  await start.getByRole("button", { name: await uiText(page, "start.link") }).click();
  await expect(page.locator("#url")).toBeFocused();

  const chooser = page.waitForEvent("filechooser");
  await start.getByRole("button", { name: await uiText(page, "start.upload") }).click();
  await chooser;

  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).dblclick();
  await expect(start).toBeHidden();
});
