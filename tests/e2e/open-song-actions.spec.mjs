// The open song offers its library row's Up Next and setlist actions from the
// song head and from Stage, where the library row is out of reach.
import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio } from "./helpers.mjs";

const SETLIST_NAME = "Gig";
const UP_NEXT_KEY = "stemdeck.upNext";

// The e2e server lives for the whole run, so each test leaves no setlist behind.
test.afterEach(async ({ request }) => {
  const res = await request.get("/api/setlists");
  for (const setlist of await res.json()) await request.delete(`/api/setlists/${setlist.id}`);
});

const serverSongIds = async (request) => (await (await request.get("/api/setlists")).json())[0]?.song_ids;
const storedUpNext = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), UP_NEXT_KEY);

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

test("the open song's menu leaves renaming to the song head's own button", async ({ page, request }) => {
  await openWithSetlist(page, request);
  await page.locator("#songMoreBtn").click();
  const menu = page.locator(".lib-menu");
  await expect(menu.getByRole("menuitem", { name: SETLIST_NAME })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Rename/ })).toHaveCount(0);
});
