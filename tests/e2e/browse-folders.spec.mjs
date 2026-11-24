// Folder rows in Browse library's nav keep today's gestures: a chevron folds a
// folder's subfolders away and the library remembers it, and dragging a row
// onto another's middle nests it there, onto its bottom edge places it after.
// Double-click and F2 rename and Unsorted's colour edit are in folder-rename.
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  openBrowse,
  readCatalogState,
  seedCatalogState,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";

const BAND = { id: "f-band", name: "Band" };
const LIVE = { id: "f-live", name: "Live" };
const GIGS = { id: "f-gigs", name: "Gigs" };
const MIDDLE = 0.5;
const BOTTOM_EDGE_PX = 2;

async function openLibrary(page, { bandCollapsed = false } = {}) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID], color: null },
      { ...BAND, items: [SIBLING_JOB_ID], color: null, collapsed: bandCollapsed },
      { ...LIVE, items: [], color: null, parentId: BAND.id },
      { ...GIGS, items: [], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
    seedOnce: true,
  });
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openBrowse(page);
}

const navRow = (page, id) => page.locator(`#browseNav .browse-nav-folder[data-folder="${id}"]`);
const chevron = (page, id) => page.locator(`#browseNav .browse-nav-chevron[data-folder="${id}"]`);
const storedFolder = async (page, id) => (await readCatalogState(page)).folders.find((f) => f.id === id);
const storedOrder = async (page) => (await readCatalogState(page)).folders.map((f) => f.id);

/** Drop `draggedId`'s row on `targetId`'s row at `clientY(box)`. */
async function dragFolder(page, draggedId, targetId, at) {
  await page.evaluate(({ draggedId, targetId, at }) => {
    const rowOf = (id) => document.querySelector(`#browseNav .browse-nav-folder[data-folder="${id}"]`);
    const source = rowOf(draggedId);
    const target = rowOf(targetId);
    const box = target.getBoundingClientRect();
    const y = at.edgePx === undefined ? box.top + box.height * at.share : box.bottom - at.edgePx;
    const init = { bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientX: box.left + box.width / 2, clientY: y };
    source.dispatchEvent(new DragEvent("dragstart", init));
    target.dispatchEvent(new DragEvent("dragover", init));
    target.dispatchEvent(new DragEvent("drop", init));
    source.dispatchEvent(new DragEvent("dragend", init));
  }, { draggedId, targetId, at });
}

test.describe("collapse", () => {
  test("the chevron folds a folder's subfolders away and back, and says which it will do", async ({ page }) => {
    await openLibrary(page);
    await expect(navRow(page, LIVE.id)).toBeVisible();
    await expect(chevron(page, BAND.id)).toHaveAttribute("aria-expanded", "true");
    await expect(chevron(page, BAND.id)).toHaveAttribute("aria-label", await uiText(page, "lib.collapseFolder", { name: BAND.name }));

    await chevron(page, BAND.id).click();
    await expect(navRow(page, LIVE.id)).toHaveCount(0);
    await expect(chevron(page, BAND.id)).toHaveAttribute("aria-expanded", "false");
    await expect(chevron(page, BAND.id)).toHaveAttribute("aria-label", await uiText(page, "lib.expandFolder", { name: BAND.name }));
    await expect(chevron(page, BAND.id)).toBeFocused();
    expect((await storedFolder(page, BAND.id)).collapsed).toBe(true);

    await page.keyboard.press("Enter");
    await expect(navRow(page, LIVE.id)).toBeVisible();
    expect((await storedFolder(page, BAND.id)).collapsed).toBe(false);
  });

  test("a collapsed folder stays collapsed after a reload", async ({ page }) => {
    await openLibrary(page);
    await chevron(page, BAND.id).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await openBrowse(page);
    await expect(navRow(page, BAND.id)).toBeVisible();
    await expect(navRow(page, LIVE.id)).toHaveCount(0);
  });

  test("only a folder with subfolders has a chevron, and its row still opens it", async ({ page }) => {
    await openLibrary(page, { bandCollapsed: true });
    await expect(page.locator("#browseNav button.browse-nav-chevron")).toHaveCount(1);
    await navRow(page, BAND.id).click();
    await expect(page.locator("#browseResults .browse-head h2")).toHaveText(BAND.name);
    await expect(navRow(page, LIVE.id)).toHaveCount(0);
  });
});

test.describe("drag", () => {
  test("a folder dropped on another's middle nests inside it", async ({ page }) => {
    await openLibrary(page);
    await dragFolder(page, GIGS.id, BAND.id, { share: MIDDLE });
    await expect.poll(async () => (await storedFolder(page, GIGS.id)).parentId).toBe(BAND.id);
    await expect(chevron(page, BAND.id)).toHaveAttribute("aria-expanded", "true");
    const dotX = async (id) => (await navRow(page, id).locator(".folder-dot").boundingBox()).x;
    expect(await dotX(GIGS.id)).toBeGreaterThan(await dotX(BAND.id));
  });

  test("a folder dropped on another's bottom edge moves after it", async ({ page }) => {
    await openLibrary(page);
    await dragFolder(page, BAND.id, GIGS.id, { edgePx: BOTTOM_EDGE_PX });
    await expect.poll(async () => {
      const order = await storedOrder(page);
      return order.indexOf(BAND.id) > order.indexOf(GIGS.id);
    }).toBe(true);
    expect((await storedFolder(page, BAND.id)).parentId ?? null).toBeNull();
  });
});
