// The open song offers its library row's Up Next and setlist actions from the
// song head and from Stage, where the library row is out of reach.
import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio, stubServerTrash, waitForPanesSettled } from "./helpers.mjs";

const SETLIST_NAME = "Gig";
const UP_NEXT_KEY = "stemdeck.upNext";
const NARROW_WINDOW = { width: 1024, height: 860 };
const OPEN_SONG_BUTTONS = ["#songUpNextBtn", "#songMoreBtn", "#stageUpNextBtn", "#stageMoreBtn"];

// The e2e server lives for the whole run, so each test leaves no setlist behind.
test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const serverSongIds = async (request) => (await (await request.get("/api/setlists")).json())[0]?.song_ids;
const storedUpNext = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), UP_NEXT_KEY);

const libraryRow = (page) => page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"]`).first();
const isCut = (locator) => locator.evaluate((el) => el.scrollWidth > el.clientWidth);

async function openRowMenu(page) {
  await libraryRow(page).hover();
  await libraryRow(page).locator(".cat-more").click();
  return page.locator(".lib-menu");
}

/** Left and right edges of the Stage bar's parts, to check none overlaps or leaves the view. */
function stageBarEdges(page) {
  return page.evaluate(() => {
    const box = (sel) => document.querySelector(sel).getBoundingClientRect();
    return {
      songRight: box(".stage-song").right,
      actionsLeft: box(".stage-song-actions").left,
      actionsRight: box(".stage-song-actions").right,
      exitLeft: box("#stageExitBtn").left,
      exitRight: box("#stageExitBtn").right,
      viewRight: box("#stageView").right,
    };
  });
}

async function openWithSetlist(page, request) {
  await request.post("/api/setlists", { data: { name: SETLIST_NAME, song_ids: [] } });
  await openStudio(page);
}

async function addToSetlistThrough(page, moreButton) {
  await moreButton.click();
  await expect(moreButton).toHaveAttribute("aria-expanded", "true");
  const menu = page.locator(".lib-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: SETLIST_NAME }).click();
  await expect(menu).toBeHidden();
}

test("the song head adds the open song to Up Next and to a setlist", async ({ page, request }) => {
  await openWithSetlist(page, request);
  const upNext = page.locator("#songUpNextBtn");
  await expect(upNext).toHaveCSS("cursor", "pointer");
  await upNext.click();
  await expect.poll(() => storedUpNext(page)).toEqual([JOB_ID]);
  await expect(page.locator("#upNextList .upnext-row")).toHaveAttribute("data-id", JOB_ID);

  const more = page.locator("#songMoreBtn");
  await expect(more).toHaveCSS("cursor", "pointer");
  await addToSetlistThrough(page, more);
  await expect.poll(() => serverSongIds(request)).toEqual([JOB_ID]);
});

test("Stage adds the open song to Up Next and to a setlist, and stays open", async ({ page, request }) => {
  await openWithSetlist(page, request);
  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageView")).toBeVisible();

  const upNext = page.locator("#stageUpNextBtn");
  await expect(upNext).toHaveCSS("cursor", "pointer");
  await upNext.click();
  await expect.poll(() => storedUpNext(page)).toEqual([JOB_ID]);
  await expect(page.locator("#stageNextBtn")).toBeEnabled();

  const more = page.locator("#stageMoreBtn");
  await expect(more).toHaveCSS("cursor", "pointer");
  await addToSetlistThrough(page, more);
  await expect.poll(() => serverSongIds(request)).toEqual([JOB_ID]);

  // Esc closes the menu, back on its button, and leaves Stage open.
  await more.click();
  await expect(page.locator(".lib-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".lib-menu")).toBeHidden();
  await expect(more).toBeFocused();
  await expect(page.locator("#stageView")).toBeVisible();
});

test("the open song's menu leaves renaming to the song head, and the row's menu keeps it", async ({ page, request }) => {
  await openWithSetlist(page, request);
  await page.locator("#songMoreBtn").click();
  const menu = page.locator(".lib-menu");
  await expect(menu.getByRole("menuitem", { name: SETLIST_NAME })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Rename/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  const rowMenu = await openRowMenu(page);
  await expect(rowMenu.getByRole("menuitem", { name: /Rename/ })).toBeVisible();
});

test("a trashed open song is offered to neither Up Next nor a setlist", async ({ page, request }) => {
  await stubServerTrash(page);
  await openWithSetlist(page, request);
  for (const button of OPEN_SONG_BUTTONS) await expect(page.locator(button)).toBeEnabled();

  await libraryRow(page).hover();
  await libraryRow(page).locator(".cat-del").click();
  for (const button of OPEN_SONG_BUTTONS) await expect(page.locator(button)).toBeDisabled();
  await page.locator("#songUpNextBtn").click({ force: true });
  await page.locator("#songMoreBtn").click({ force: true });
  await page.locator("#stageModeBtn").click();
  await page.locator("#stageUpNextBtn").click({ force: true });
  await page.locator("#stageMoreBtn").click({ force: true });
  await expect(page.locator(".lib-menu")).toHaveCount(0);
  expect(await storedUpNext(page)).toEqual([]);
  expect(await serverSongIds(request)).toEqual([]);
});

test("at 1024 with the library collapsed the title keeps its room and the Stage bar fits", async ({ page }) => {
  await page.setViewportSize(NARROW_WINDOW);
  await openStudio(page);
  await waitForPanesSettled(page);
  await expect(page.locator(".app")).toHaveClass(/cat-collapsed/);
  expect(await isCut(page.locator("#title"))).toBe(false);

  await page.locator("#stageModeBtn").click();
  await expect(page.locator("#stageMoreBtn")).toBeVisible();
  expect(await isCut(page.locator("#stageTitle"))).toBe(false);
  const bar = await stageBarEdges(page);
  expect(bar.actionsLeft).toBeGreaterThanOrEqual(bar.songRight);
  expect(bar.exitLeft).toBeGreaterThanOrEqual(bar.actionsRight);
  expect(bar.exitRight).toBeLessThanOrEqual(bar.viewRight);
});
