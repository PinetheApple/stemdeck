// The library's finish: a view's count follows the search while the nav's counts
// do not, one empty-state look, labels that fit, dialog titles that match the
// action, row menus that leave the rows readable, and a main area that says how
// to start when no song is open.
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
  openBrowse,
} from "./helpers.mjs";

const EMPTY_FOLDER_ID = "f-empty";
const UNSORTED_ID = "f-unsorted";
const NO_MATCH_QUERY = "zzzz-no-such-song";
const LANGUAGES = ["en", "pl", "ja", "ko", "zh-Hans", "de", "fr", "es", "pt", "pt-PT", "id"];

/** The library without opening a song, so the empty main area stays up. */
async function openLibrary(page, { emptyFolder = false } = {}) {
  if (emptyFolder) await seedWithEmptyFolder(page);
  else await seedLibrary(page);
  await loadSeededLibrary(page);
}

async function loadSeededLibrary(page) {
  await stubFavorites(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`.cat-item[data-id="${JOB_ID}"]`)).toBeVisible();
}

async function seedWithEmptyFolder(page) {
  await seedCatalogState(page, {
    folders: [
      { id: UNSORTED_ID, name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
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
  await page.locator("#browseSearch").fill(query);
}

const headCount = (page) => page.locator("#browseResults .browse-head-count");
const navCount = (page, view) => page.locator(`#browseNav .browse-nav-btn[data-view="${view}"] .browse-nav-count`);

/** An empty list says so with the one look: an icon, a heading and a hint. */
async function expectEmptyState(page, headingKey, hintKey) {
  const empty = page.locator("#browseResults .browse-empty");
  await expect(empty).toHaveCount(1);
  await expect(empty.locator("svg")).toBeVisible();
  await expect(empty.locator("strong")).toHaveText(await uiText(page, headingKey));
  await expect(empty.locator("span")).toHaveText(await uiText(page, hintKey));
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

const setLanguage = (page, code) => page.evaluate(async (c) => (await import("/js/i18n.js")).setLanguage(c), code);

const startsWithText = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const SETLISTS = [
  { id: "sl-gig", name: "Gig", song_ids: [JOB_ID] },
  { id: "sl-practice", name: "Practice", song_ids: [] },
];

test("a view's count follows the search; the nav's counts stay the library's", async ({ page }) => {
  await page.route("**/api/setlists", (route) => route.fulfill({ json: SETLISTS }));
  await openLibrary(page);
  await openBrowse(page);
  await expect(headCount(page)).toHaveText("2 songs");

  await search(page, "again");
  await expect(page.locator("#browseResults .cat-item")).toHaveCount(1);
  await expect(headCount(page)).toHaveText("1 song");
  await expect(navCount(page, "all")).toHaveText("2");
  await expect(navCount(page, "setlist:sl-gig")).toHaveText("1");

  await search(page, NO_MATCH_QUERY);
  await expect(headCount(page)).toHaveText("0 songs");
  await expect(navCount(page, "all")).toHaveText("2");
});

test("Trash, Favorites and a search with no match share one empty state", async ({ page }) => {
  await openLibrary(page);
  await openBrowse(page);
  await search(page, NO_MATCH_QUERY);
  await expectEmptyState(page, "library.noSearchMatch", "search.noMatchHint");

  await search(page, "");
  await openBrowse(page, "trash");
  await expectEmptyState(page, "trash.isEmptyState", "trash.emptyHint");

  await openBrowse(page, "fav");
  await expectEmptyState(page, "favorites.emptyTitle", "favorites.emptyHint");
  await search(page, NO_MATCH_QUERY);
  await expectEmptyState(page, "library.noSearchMatch", "search.noMatchHint");
});

test("the empty states look like the empty setlist's", async ({ page }) => {
  await page.route("**/api/setlists", (route) => route.fulfill({ json: SETLISTS }));
  await openLibrary(page);
  await openBrowse(page, "trash");
  const trashLook = await lookOf(page.locator("#browseResults .browse-empty"));
  await openBrowse(page, "setlist:sl-practice");
  expect(trashLook).toEqual(await lookOf(page.locator("#browseResults .browse-empty")));
});

test("an empty folder says so in the app's language", async ({ page }) => {
  await openLibrary(page, { emptyFolder: true });
  await openBrowse(page, `folder:${EMPTY_FOLDER_ID}`);
  await expect(page.locator("#browseResults .browse-empty strong")).toHaveText(await uiText(page, "library.emptyFolder"));
});

const FIXED_LABELS = [
  "#browseBtn > span",
  "#trashBtn > span[data-i18n]",
  ...["all", "fav", "recent", "trash"].map((view) => `#browseNav [data-view="${view}"] .browse-nav-label`),
];

test("every library view label fits its button, in every language", async ({ page }) => {
  await openLibrary(page);
  await openBrowse(page);
  for (const code of LANGUAGES) {
    await setLanguage(page, code);
    const cut = await page.evaluate((selectors) => selectors
      .map((selector) => document.querySelector(selector))
      .filter((label) => label?.offsetParent)
      .filter((label) => {
        const box = label.getBoundingClientRect();
        const button = label.closest("button").getBoundingClientRect();
        return label.scrollWidth > label.clientWidth || box.left < button.left || box.right > button.right;
      })
      .map((label) => label.textContent), FIXED_LABELS);
    expect(cut, `cut short in ${code}`).toEqual([]);
  }
});

const TOP_BAR_ICON_BUTTONS = ["#helpModeBtn", "#notifBtn", "#settingsBtn", "#aboutBtn"];

test("a top-bar icon button is named and has a tooltip, in every language", async ({ page }) => {
  await openLibrary(page);
  for (const code of LANGUAGES) {
    await setLanguage(page, code);
    for (const selector of TOP_BAR_ICON_BUTTONS) {
      const button = page.locator(selector);
      await expect(button, `${selector} in ${code}`).toHaveAccessibleName(/\S/);
      await expect(button, `${selector} in ${code}`).toHaveAttribute("title", /\S/);
    }
  }
});

test("Guide and About are told apart by name and tooltip, and do different things", async ({ page }) => {
  await openLibrary(page);
  const guide = page.locator("#helpModeBtn");
  const about = page.locator("#aboutBtn");
  await expect(about).toHaveAttribute("title", await uiText(page, "nav.aboutTitle"));
  await expect(about).toHaveAccessibleName(await uiText(page, "nav.about"));
  expect(await guide.getAttribute("aria-label")).not.toBe(await about.getAttribute("aria-label"));
  expect(await guide.getAttribute("title")).not.toBe(await about.getAttribute("title"));

  await about.click();
  await expect(page.locator('.settings-pane[data-pane="about"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await guide.click();
  await expect(guide).toHaveAttribute("aria-pressed", "true");
});

test("New folder opens a dialog titled New folder; editing one says Edit folder", async ({ page }) => {
  await openLibrary(page);
  await openBrowse(page);
  await page.locator("#browseNewFolder").click();
  const dialog = page.locator(".folder-editor");
  const newTitle = await uiText(page, "library.newFolder");
  await expect(dialog.locator(".folder-editor-head > span")).toHaveText(newTitle);
  await expect(dialog).toHaveAttribute("aria-label", newTitle);
  await dialog.locator(".folder-editor-cancel").click();

  await page.locator(`#browseNav .browse-nav-folder[data-folder="${UNSORTED_ID}"]`).dblclick();
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

// Too narrow beside any row, and tall enough for room both above and below the
// fixture rows once unavailable rows pad the list around them.
const NARROW_TALL_WINDOW = { width: 400, height: 900 };
const PADDING_ROWS = 4;

const paddingIds = (side) => Array.from({ length: PADDING_ROWS }, (_, i) => `pad-${side}-${i}`);

// Favorites, so the sidebar lists every one of them, in this order.
const favoriteTrack = (id, title) => ({ ...fixtureTrack(id, title), favorite: true });

async function seedPaddedList(page) {
  const padding = [...paddingIds("above"), ...paddingIds("below")];
  await seedCatalogState(page, {
    folders: [
      { id: UNSORTED_ID, name: "Unsorted", items: [...paddingIds("above"), JOB_ID, SIBLING_JOB_ID, ...paddingIds("below")], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      ...Object.fromEntries(padding.map((id) => [id, favoriteTrack(id, id)])),
      [JOB_ID]: favoriteTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: favoriteTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
  await loadSeededLibrary(page);
}

test("with no room beside a middle row, the row menu opens above it, not on the next row", async ({ page }) => {
  await page.setViewportSize(NARROW_TALL_WINDOW);
  await seedPaddedList(page);
  const row = page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`);
  await row.hover();
  await row.locator(".cat-more").click();
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();
  const menuBox = await boxOf(menu);
  const rowBox = await boxOf(row);
  const menuHeight = menuBox.bottom - menuBox.top;
  expect(menuBox.left, "no room beside the row").toBeLessThan(rowBox.right);
  expect(rowBox.top, "room above the row").toBeGreaterThan(menuHeight);
  expect(NARROW_TALL_WINDOW.height - rowBox.bottom, "room below the row").toBeGreaterThan(menuHeight);
  expect(overlaps(menuBox, rowBox), "menu covers its own row").toBe(false);
  const nextRow = page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`);
  expect(overlaps(menuBox, await boxOf(nextRow)), "menu covers the next row").toBe(false);
});

// No width the app supports leaves the menu no room beside a row, so this stays below
// 620; many setlists make the menu too tall to fit under the row.
const MANY_SETLISTS = Array.from({ length: 10 }, (_, i) => ({ id: `sl-${i}`, name: `Setlist ${i}`, song_ids: [] }));

test("with no room beside or below its row, the row menu opens above it", async ({ page }) => {
  await page.setViewportSize(NARROW_TALL_WINDOW);
  await page.route("**/api/setlists", (route) => route.fulfill({ json: MANY_SETLISTS }));
  await seedPaddedList(page);
  const row = page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`);
  await row.hover();
  await row.locator(".cat-more").click();
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();
  const menuBox = await boxOf(menu);
  const rowBox = await boxOf(row);
  const menuHeight = menuBox.bottom - menuBox.top;
  expect(menuBox.left, "no room beside the row").toBeLessThan(rowBox.right);
  expect(rowBox.top, "room above the row").toBeGreaterThan(menuHeight);
  expect(NARROW_TALL_WINDOW.height - rowBox.bottom, "no room below the row").toBeLessThan(menuHeight);
  expect(overlaps(menuBox, rowBox), "menu covers its own row").toBe(false);
  const nextRow = page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`);
  expect(overlaps(menuBox, await boxOf(nextRow)), "menu covers the next row").toBe(false);
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

  await start.getByRole("button", { name: await uiText(page, "batch.pasteLinks") }).click();
  await expect(page.locator("#url")).toBeFocused();

  const chooser = page.waitForEvent("filechooser");
  await start.getByRole("button", { name: await uiText(page, "batch.chooseFiles") }).click();
  await chooser;

  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().dblclick();
  await expect(start).toBeHidden();
});
