// One song menu everywhere: the ⋯ button and a right-click open it on a song
// in the sidebar, in Browse library's grid and list, in a setlist and on the open
// song's head; rows show only Add to Up Next and ⋯, cards a heart and ⋯.

import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  KEY,
  SIBLING_JOB_ID,
  TRACK_TITLE,
  browseRow,
  fixtureTrack,
  openBrowse,
  openStudio,
  seedCatalogState,
  stubExportEndpoints,
  stubFavorites,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";

const SETLIST_NAME = "Gig";
const SETLISTS_PATH = "/api/setlists";
const MENU = ".lib-menu.song-menu";
const RIGHT = "right";
// The song is in the setlist and in Unsorted, so those two items are disabled.
const ENABLED_ITEMS = 8;
const ITEMS_IN_ORDER = [
  "Play now", "Add to Up Next", "Add to Favorites", "Rename…", "About this song",
  SETLIST_NAME, "New setlist with this song", "Unsorted", "New folder…", "Move to Trash",
];
const sidebarRow = (page, id) => page.locator(`#catalogList .cat-item[data-id="${id}"]`).first();
const menu = (page) => page.locator(MENU);
const menuLabels = (page) => menu(page).getByRole("menuitem").allInnerTexts();

test.afterEach(async ({ request }) => {
  const res = await request.get(SETLISTS_PATH);
  for (const setlist of await res.json()) await request.delete(`${SETLISTS_PATH}/${setlist.id}`);
});

async function openLibrary(page) {
  const ids = [JOB_ID, SIBLING_JOB_ID];
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: ids, color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: Object.fromEntries(ids.map((id) => [id, fixtureTrack(id, id === JOB_ID ? TRACK_TITLE : id)])),
  });
  await stubFavorites(page);
  await stubServerTrash(page);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(sidebarRow(page, JOB_ID)).toBeVisible();
}

/** The menu's items opened from `button` and from a right-click on `target`, each closed again with Esc. */
async function labelsBothWays(page, target, button) {
  await target.hover();
  await button.click();
  await expect(menu(page)).toBeVisible();
  const fromButton = await menuLabels(page);
  await page.keyboard.press(KEY.ESCAPE);
  await expect(menu(page)).toHaveCount(0);
  await target.click({ button: RIGHT });
  await expect(menu(page)).toBeVisible();
  const fromRightClick = await menuLabels(page);
  await page.keyboard.press(KEY.ESCAPE);
  await expect(menu(page)).toHaveCount(0);
  return { fromButton, fromRightClick };
}

async function rightClickLabels(page, target) {
  await target.click({ button: RIGHT });
  await expect(menu(page)).toBeVisible();
  const labels = await menuLabels(page);
  await page.keyboard.press(KEY.ESCAPE);
  return labels;
}

test("⋯ and right-click open the same menu in the sidebar, Browse grid, Browse list and a setlist", async ({ page, request }) => {
  await request.post(SETLISTS_PATH, { data: { name: SETLIST_NAME, song_ids: [SIBLING_JOB_ID] } });
  await openLibrary(page);

  const sidebar = await labelsBothWays(page, sidebarRow(page, JOB_ID), sidebarRow(page, JOB_ID).locator(".cat-more"));
  expect(sidebar.fromButton).toEqual(ITEMS_IN_ORDER);
  expect(sidebar.fromRightClick).toEqual(ITEMS_IN_ORDER);

  await openBrowse(page);
  const card = browseRow(page, JOB_ID);
  const grid = await labelsBothWays(page, card, card.locator(".song-card-more"));
  expect(grid).toEqual(sidebar);

  await page.locator("#browseListBtn").click();
  const row = browseRow(page, JOB_ID);
  const list = await labelsBothWays(page, row, row.locator(".cat-more"));
  expect(list).toEqual(sidebar);

  await page.locator(`#browseNav .browse-nav-btn[data-view^="setlist:"]`, { hasText: SETLIST_NAME }).click();
  const setlistRow = page.locator(`#browseResults .setlist-song[data-id="${SIBLING_JOB_ID}"]`);
  const inSetlist = await labelsBothWays(page, setlistRow, setlistRow.locator(".cat-more"));
  expect(inSetlist).toEqual({ fromButton: ITEMS_IN_ORDER, fromRightClick: ITEMS_IN_ORDER });
  await expect(setlistRow.locator(".setlist-song-up, .setlist-song-down, .setlist-song-remove")).toHaveCount(3);
});

test("the song head's ⋯ and right-click give the menu without Rename…", async ({ page }) => {
  await openStudio(page);
  const more = page.locator("#songMoreBtn");
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  const fromButton = await menuLabels(page);
  await page.keyboard.press(KEY.ESCAPE);
  await expect(more).toBeFocused();

  const fromRightClick = await rightClickLabels(page, page.locator("#np-art"));
  expect(fromRightClick).toEqual(fromButton);
  expect(fromButton).not.toContain("Rename…");
  expect(fromButton).toEqual(expect.arrayContaining(["Play now", "About this song", "Move to Trash"]));
});

test("a row shows only Add to Up Next and ⋯ on hover and selection; a card shows heart and ⋯ on its cover", async ({ page }) => {
  await openLibrary(page);
  const row = sidebarRow(page, JOB_ID);
  await row.hover();
  await expect(row.locator(".cat-actions button:visible")).toHaveCount(2);
  await expect(row.locator(".cat-upnext")).toBeVisible();
  await expect(row.locator(".cat-more")).toBeVisible();
  await expect(row.locator(".cat-fav, .cat-del")).toHaveCount(0);

  await row.click();
  await page.mouse.move(0, 0);
  await expect(row.locator(".cat-upnext")).toBeVisible();
  await expect(row.locator(".cat-more")).toBeVisible();

  await openBrowse(page);
  const card = browseRow(page, JOB_ID);
  await card.hover();
  const heart = card.locator(".cat-thumb .song-card-fav");
  await expect(heart).toBeVisible();
  await expect(card.locator(".cat-thumb .song-card-more")).toBeVisible();
  await expect(heart).toHaveCSS("cursor", "pointer");
  await expect(heart).toHaveAttribute("aria-pressed", "false");
  await heart.click();
  await expect(card.locator(".song-card-fav")).toHaveAttribute("aria-pressed", "true");
  await page.mouse.move(0, 0);
  await expect(browseRow(page, SIBLING_JOB_ID).locator(".song-card-fav")).toBeHidden();
  await expect(card.locator(".song-card-fav")).toBeVisible();
});

test("a right-click at the window's bottom-right corner keeps the whole menu inside", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await openLibrary(page);
  await sidebarRow(page, JOB_ID).evaluate((row) => {
    const at = { bubbles: true, cancelable: true, button: 2, clientX: innerWidth - 2, clientY: innerHeight - 2 };
    row.dispatchEvent(new MouseEvent("contextmenu", at));
  });
  await expect(menu(page)).toBeVisible();
  const box = await menu(page).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
  });
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(box.width);
  expect(box.bottom).toBeLessThanOrEqual(box.height);
});

test("arrow keys move through enabled items, Home/End jump, Esc closes and returns focus", async ({ page, request }) => {
  await request.post(SETLISTS_PATH, { data: { name: SETLIST_NAME, song_ids: [JOB_ID] } });
  await openLibrary(page);
  const row = sidebarRow(page, JOB_ID);
  const more = row.locator(".cat-more");
  await row.hover();
  await more.click();
  const focused = () => page.evaluate(() => document.activeElement?.textContent.trim());
  await expect.poll(focused).toBe("Play now");

  const visited = [];
  for (let i = 0; i < ENABLED_ITEMS; i++) {
    await page.keyboard.press("ArrowDown");
    visited.push(await focused());
  }
  expect(visited).not.toContain(SETLIST_NAME);
  expect(visited).not.toContain("Unsorted");
  expect(visited).not.toContain("Add to setlist");
  expect(visited.at(-1)).toBe("Play now");

  await page.keyboard.press("End");
  expect(await focused()).toBe("Move to Trash");
  await page.keyboard.press("Home");
  expect(await focused()).toBe("Play now");
  await page.keyboard.press("ArrowUp");
  expect(await focused()).toBe("Move to Trash");

  await page.keyboard.press(KEY.ESCAPE);
  await expect(menu(page)).toHaveCount(0);
  await expect(more).toBeFocused();
});
