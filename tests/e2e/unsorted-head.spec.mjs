// Unsorted is a system folder: every new import lands in it, it cannot be
// deleted, and it has nothing to reorder. In Browse library its row cannot be
// dragged and its view offers neither Make a setlist nor a … menu (#695).
//
// A folder the user made keeps all of that: its row drags to reorder and nest,
// and its view has Make a setlist and the … menu.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  TRACK_TITLE,
  SIBLING_TITLE,
  fixtureTrack,
  openBrowse,
  seedCatalogState,
  stubExportEndpoints,
  stubUpdateCheck,
} from "./helpers.mjs";

const navRow = (page, id) => page.locator(`#browseNav .browse-nav-folder[data-folder="${id}"]`);
const head = (page) => page.locator("#browseResults .browse-head");

async function open(page) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID], color: null },
      { id: "f-mine", name: "Mine", items: [SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openBrowse(page);
}

test.describe("Unsorted folder", () => {
  test("its row does not drag and its view has no Make a setlist or … menu", async ({ page }) => {
    await open(page);
    await expect(navRow(page, "f-unsorted")).not.toHaveAttribute("draggable", "true");
    await openBrowse(page, "folder:f-unsorted");
    await expect(head(page).locator("h2")).toHaveText("Unsorted");
    await expect(head(page).locator(".browse-make-setlist")).toHaveCount(0);
    await expect(head(page).locator(".browse-folder-more")).toHaveCount(0);
    // The one New folder button is on the Folders heading.
    await expect(page.locator("#browseNewFolder")).toHaveCount(1);
  });

  test("a user folder drags, and its view has Make a setlist and the … menu", async ({ page }) => {
    await open(page);
    await expect(navRow(page, "f-mine")).toHaveAttribute("draggable", "true");
    await openBrowse(page, "folder:f-mine");
    await expect(head(page).locator(".browse-make-setlist")).toBeVisible();
    await expect(head(page).locator(".browse-folder-more")).toBeVisible();
  });
});
