// The sidebar: Browse library, then Importing while imports run, Favorites (with
// the song in the player), Setlists and Recently played, and Trash with its count at the foot.

import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  openStudio,
  seedCatalogState,
  stubFavorites,
  stubImportQueue,
  stubServerTrash,
} from "./helpers.mjs";

const SETLISTS_PATH = "/api/setlists";
const IMPORT_ID = "e2e0abc00001";
const group = (page, id) => page.locator(`#${id}`);
const groupRow = (page, id, songId) => group(page, id).locator(`.cat-item[data-id="${songId}"]`);

test.afterEach(async ({ request }) => {
  const res = await request.get(SETLISTS_PATH);
  for (const setlist of await res.json()) await request.delete(`${SETLISTS_PATH}/${setlist.id}`);
});

test("the sidebar lists Browse library, Favorites, Setlists, Recently played, and Trash with its count", async ({ page, request }) => {
  await request.post(SETLISTS_PATH, { data: { name: "Gig", song_ids: [JOB_ID] } });
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [SIBLING_JOB_ID], color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, TRACK_TITLE), favorite: true },
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
  await stubServerTrash(page, { trashed: [SIBLING_JOB_ID] });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await expect(page.locator("#browseBtn")).toContainText("Browse library");
  await expect(group(page, "sidebarImporting")).toBeHidden();
  await expect(group(page, "sidebarFavorites").locator(".sidebar-group-head")).toContainText("Favorites");
  await expect(groupRow(page, "sidebarFavorites", JOB_ID)).toBeVisible();
  const setlist = group(page, "sidebarSetlists").locator(".sidebar-setlist");
  await expect(setlist).toHaveCount(1);
  await expect(setlist).toContainText("Gig");
  await expect(setlist).toContainText("Setlist · 1 song");
  await expect(setlist.locator(".sidebar-setlist-play")).toHaveAttribute("aria-label", "Play Gig from the top");
  await expect(group(page, "sidebarRecent").locator(".sidebar-group-head")).toContainText("Recently played");
  await expect(page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`)).toHaveCount(0);

  const trash = page.locator("#trashBtn");
  await expect(trash).toContainText("Trash");
  await expect(trash.locator("#trashBadge")).toHaveText("1");
});

test("Importing shows only while an import runs", async ({ page }) => {
  await openStudio(page);
  const queue = await stubImportQueue(page, IMPORT_ID, "Incoming song");
  await expect(group(page, "sidebarImporting")).toBeHidden();
  await queue.run();
  await expect(group(page, "sidebarImporting")).toBeVisible();
  await expect(group(page, "sidebarImporting").locator(".sidebar-group-list")).toContainText("Incoming song");
  await group(page, "sidebarImporting").locator(".sidebar-see-all").click();
  await expect(page.locator("#browseImportQueue")).toBeVisible();
  await page.keyboard.press("Escape");
  await queue.settle();
  await expect(group(page, "sidebarImporting")).toBeHidden();
});

test("the song in the player is listed under Favorites when it is not a favorite", async ({ page }) => {
  await openStudio(page);
  await expect(groupRow(page, "sidebarFavorites", JOB_ID)).toBeVisible();
  await expect(groupRow(page, "sidebarFavorites", SIBLING_JOB_ID)).toHaveCount(0);

  await groupRow(page, "sidebarRecent", SIBLING_JOB_ID).dblclick();
  await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });
  await expect(groupRow(page, "sidebarFavorites", SIBLING_JOB_ID)).toBeVisible();
  await expect(groupRow(page, "sidebarFavorites", JOB_ID)).toHaveCount(0);
});

test("a song dropped on a sidebar setlist or on Trash goes there", async ({ page, request }) => {
  const { id } = await (await request.post(SETLISTS_PATH, { data: { name: "Drop here", song_ids: [] } })).json();
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
  await stubFavorites(page);
  await stubServerTrash(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const setlistRow = group(page, "sidebarSetlists").locator(`.sidebar-setlist[data-id="${id}"]`);
  // The song in the player heads Favorites, so the drags start from the other one, in Recently played.
  const recentRow = groupRow(page, "sidebarRecent", SIBLING_JOB_ID);
  await recentRow.dragTo(setlistRow);
  await expect.poll(async () => (await (await request.get(SETLISTS_PATH)).json()).find((s) => s.id === id)?.song_ids).toEqual([SIBLING_JOB_ID]);
  await expect(setlistRow).toContainText("Setlist · 1 song");

  await recentRow.dragTo(page.locator("#trashBtn"));
  await expect(page.locator("#trashBadge")).toHaveText("1");
  await expect(page.locator(`#catalogList .cat-item[data-id="${SIBLING_JOB_ID}"]`)).toHaveCount(0);
});

test("Recently played skips a song that can no longer play", async ({ page }) => {
  const goneId = "e2e0feed0bad";
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID, goneId], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
      [goneId]: { ...fixtureTrack(goneId, "Gone"), status: "unavailable" },
    },
  });
  await page.addInitScript((ids) => window.localStorage.setItem("stemdeck.recentlyPlayed", JSON.stringify(ids)), [goneId, SIBLING_JOB_ID]);
  await stubFavorites(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(groupRow(page, "sidebarRecent", SIBLING_JOB_ID)).toBeVisible();
  await expect(groupRow(page, "sidebarRecent", goneId)).toHaveCount(0);
});
