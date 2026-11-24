// The Trash: each row has a Restore button that sends the song back to the
// library, a click on a row opens nothing, and the Trash button carries a count,
// so a full Trash is visible from anywhere (#749).
//
// The server's Trash is stubbed (stubServerTrash): the real one would leave the
// shared fixture jobs trashed for the next spec's startup sync.

import { test, expect } from "@playwright/test";

import {
  JOB_ID,
  KEY,
  SIBLING_JOB_ID,
  TRACK_TITLE,
  fixtureTrack,
  openBrowse,
  readCatalogState,
  seedCatalogState,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";

const THIRD_ID = "e2e0feedface";
const TRASHED = [JOB_ID, SIBLING_JOB_ID, THIRD_ID];

async function seedFullTrash(page) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [], color: null },
      { id: "trash", name: "Trash", items: [...TRASHED], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, "Second Trashed"),
      [THIRD_ID]: { ...fixtureTrack(THIRD_ID, "Third Trashed"), sourceUrl: "local:third.wav" },
    },
  });
  await stubUpdateCheck(page);
  return (await stubServerTrash(page, { trashed: TRASHED })).calls;
}

async function openTrash(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openBrowse(page, "trash");
  for (const id of TRASHED) await expect(trashRow(page, id)).toBeVisible();
}

const trashRow = (page, id) => page.locator(`#browseResults .cat-item.in-trash[data-id="${id}"]`);
const restoreButton = (page, id) => trashRow(page, id).locator(".cat-restore");
const restoreCalls = (calls) => calls.filter((c) => c.action === "restore").map((c) => c.id).sort();

test.describe("the Trash button", () => {
  test("shows how many songs are in the Trash", async ({ page }) => {
    await seedFullTrash(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const badge = page.locator("#trashBadge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("3");
    await expect(page.locator("#trashBtn")).toHaveAttribute("aria-label", "Trash (3)");
  });

  test("shows no count when the Trash is empty", async ({ page }) => {
    await seedCatalogState(page, {
      folders: [
        { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID], color: null },
        { id: "trash", name: "Trash", items: [], color: null },
      ],
      tracks: {
        [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
        [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, "Second"),
      },
    });
    await stubUpdateCheck(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".cat-item").first()).toBeVisible();
    await expect(page.locator("#trashBadge")).toBeHidden();
    await expect(page.locator("#trashBtn")).toHaveAttribute("aria-label", "Trash");
  });

  test("opens Browse library at the Trash", async ({ page }) => {
    await seedFullTrash(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("#trashBtn").click();
    await expect(page.locator('#browseNav [data-view="trash"]')).toHaveAttribute("aria-current", "page");
    await expect(trashRow(page, JOB_ID)).toBeVisible();
  });
});

test.describe("a Trash row", () => {
  test("names its Restore button after the song", async ({ page }) => {
    await seedFullTrash(page);
    await openTrash(page);
    await expect(restoreButton(page, JOB_ID)).toHaveAttribute("aria-label", `Restore ${TRACK_TITLE}`);
  });

  test("a click opens nothing and restores nothing", async ({ page }) => {
    const calls = await seedFullTrash(page);
    await openTrash(page);
    await trashRow(page, JOB_ID).locator(".cat-meta").click();
    await expect(page.locator(".app")).toHaveClass(/no-track/);
    await expect(trashRow(page, JOB_ID)).toBeVisible();
    expect(restoreCalls(calls)).toEqual([]);
  });

  test("Restore sends the song back to the library", async ({ page }) => {
    const calls = await seedFullTrash(page);
    await openTrash(page);
    await restoreButton(page, JOB_ID).click();
    await expect(trashRow(page, JOB_ID)).toHaveCount(0);
    await expect(trashRow(page, SIBLING_JOB_ID)).toBeVisible();
    await expect.poll(() => restoreCalls(calls)).toEqual([JOB_ID]);
    await expect(page.locator("#trashBadge")).toHaveText("2");

    const state = await readCatalogState(page);
    expect(state.folders.find((f) => f.id === "trash").items).not.toContain(JOB_ID);
    expect(state.folders.find((f) => f.id === "f-unsorted").items).toContain(JOB_ID);
  });

  test("Restore reached by keyboard restores the row too", async ({ page }) => {
    const calls = await seedFullTrash(page);
    await openTrash(page);
    await trashRow(page, JOB_ID).focus();
    await page.keyboard.press("ArrowRight");
    await expect(restoreButton(page, JOB_ID)).toBeFocused();
    await page.keyboard.press(KEY.ENTER);
    await expect(trashRow(page, JOB_ID)).toHaveCount(0);
    await expect.poll(() => restoreCalls(calls)).toEqual([JOB_ID]);
  });
});
