// Destructive library actions ask first, and keyboard delete stays in the
// library.
//
// Every call that would change the shared backend is stubbed: the fixture job
// is used by the whole run, so a real trash or delete here would break every
// spec after this one.

import { test, expect } from "@playwright/test";

import {
  JOB_ID,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  failureMessages,
  fixtureTrack,
  openStudio,
  readCatalogState,
  seedCatalogState,
  stubImportQueue,
  stubUpdateCheck,
  uiText,
} from "./helpers.mjs";

const QUEUED_ID = "e2e0feedbeef";
const DELETED_JOBS_KEY = "stemdeck.deleted_jobs";
const TRASH_POLYLINE = 'polyline[points="3 6 5 6 21 6"]';

/** Answer trash, restore, cancel and DELETE here, and record what was asked. */
async function stubLibraryWrites(page, { failDelete = new Set() } = {}) {
  const calls = { trashed: [], cancelled: [], deleted: [] };
  await page.route(/\/api\/jobs\/[a-f0-9]{12}\/(trash|restore|cancel)$/, (route) => {
    const [, id, action] = route.request().url().match(/jobs\/([a-f0-9]{12})\/(\w+)$/);
    if (action === "trash") calls.trashed.push(id);
    if (action === "cancel") calls.cancelled.push(id);
    return route.fulfill({ status: 200, json: { job_id: id } });
  });
  await page.route(/\/api\/jobs\/[a-f0-9]{12}$/, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const id = route.request().url().split("/").pop();
    calls.deleted.push(id);
    if (failDelete.has(id)) return route.fulfill({ status: 500, json: { detail: "files could not be deleted" } });
    return route.fulfill({ status: 200, json: { job_id: id, status: "deleted" } });
  });
  return calls;
}

async function seedFolders(page, folders) {
  await seedCatalogState(page, {
    folders,
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
  await stubUpdateCheck(page);
}

const unsorted = (items) => ({ id: "f-unsorted", name: "Unsorted", items, color: null });
const trashFolder = (items) => ({ id: "trash", name: "Trash", items, color: null });

async function trashItems(page) {
  return (await readCatalogState(page))?.folders.find((f) => f.id === "trash")?.items ?? [];
}


const UPLOAD_SOURCE = "local:Uploaded file.wav";
const LINK_SOURCE = "https://www.youtube.com/watch?v=e2e0feedbee";

/** The queue view with one running import from `sourceUrl`; its cancel button. */
async function queueWithImport(page, sourceUrl) {
  await seedFolders(page, [unsorted([JOB_ID, SIBLING_JOB_ID]), trashFolder([])]);
  const calls = await stubLibraryWrites(page);
  const queue = await stubImportQueue(page, QUEUED_ID, "Importing", { sourceUrl });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await queue.run();
  await page.locator(".rail-queue").click();
  const cancel = page.locator(`.queue-row[data-id="${QUEUED_ID}"] .queue-cancel`);
  await expect(cancel).toBeVisible();
  return { calls, cancel };
}

test.describe("the queue's cancel", () => {
  test("asks first for an upload, which is lost for good", async ({ page }) => {
    const { calls, cancel } = await queueWithImport(page, UPLOAD_SOURCE);
    await expect(cancel.locator(TRASH_POLYLINE)).toHaveCount(0);

    await cancel.click();
    await expect(cancel).toHaveAttribute("data-armed", "1");
    await expect(cancel).toContainText(await uiText(page, "queue.cancelConfirm"));
    expect(calls.cancelled).toEqual([]);

    await cancel.click();
    await expect.poll(() => calls.cancelled).toEqual([QUEUED_ID]);
  });

  test("cancels a link import at once", async ({ page }) => {
    const { calls, cancel } = await queueWithImport(page, LINK_SOURCE);
    await cancel.click();
    await expect.poll(() => calls.cancelled).toEqual([QUEUED_ID]);
    await expect(cancel).not.toHaveAttribute("data-armed", "1");
  });

  test("a cancel the server refused says so and can be tried again", async ({ page }) => {
    const { cancel } = await queueWithImport(page, LINK_SOURCE);
    await page.route(/\/api\/jobs\/[a-f0-9]{12}\/cancel$/, (route) => route.fulfill({ status: 500, json: {} }));

    await cancel.click();
    await expect.poll(() => failureMessages(page)).toEqual([await uiText(page, "notif.cancelFailed")]);
    await expect(cancel).toBeEnabled();
  });
});

test.describe("Empty trash", () => {
  test("asks first, and keeps a song whose delete failed in the Trash", async ({ page }) => {
    const failDelete = new Set([JOB_ID]);
    await seedFolders(page, [unsorted([]), trashFolder([JOB_ID, SIBLING_JOB_ID])]);
    const calls = await stubLibraryWrites(page, { failDelete });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator(".rail-trash").click();

    const empty = page.locator("#clearBinBtn");
    await empty.click();
    await expect(empty).toHaveAttribute("data-armed", "1");
    await expect(empty).toContainText("Delete permanently?");
    expect(calls.deleted).toEqual([]);

    await empty.click();
    await expect.poll(() => trashItems(page)).toEqual([JOB_ID]);
    await expect(page.locator(`.cat-item.in-trash[data-id="${JOB_ID}"]`)).toBeVisible();
    await expect.poll(() => failureMessages(page)).toEqual([await uiText(page, "library.deleteFailed", { count: 1 })]);

    failDelete.clear();
    await empty.click();
    await empty.click();
    await expect.poll(() => trashItems(page)).toEqual([]);
  });
});

test("Empty trash says so when the device cannot record what it deleted", async ({ page }) => {
  await page.addInitScript((key) => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function refuseDeletedJobs(k, v) {
      if (k === key) throw new DOMException("full", "QuotaExceededError");
      return setItem.call(this, k, v);
    };
  }, DELETED_JOBS_KEY);
  await seedFolders(page, [unsorted([]), trashFolder([SIBLING_JOB_ID])]);
  await stubLibraryWrites(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".rail-trash").click();

  const empty = page.locator("#clearBinBtn");
  await empty.click();
  await empty.click();

  await expect.poll(() => failureMessages(page)).toEqual([await uiText(page, "notif.storageFull")]);
});

test.describe("deleting a folder", () => {
  test("asks first, then bins its songs and its subfolder's, and tells the server", async ({ page }) => {
    await seedFolders(page, [
      unsorted([]),
      { id: "f-band", name: "Band", items: [JOB_ID], color: null, parentId: null },
      { id: "f-live", name: "Live", items: [SIBLING_JOB_ID], color: null, parentId: "f-band" },
      trashFolder([]),
    ]);
    const calls = await stubLibraryWrites(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const head = page.locator('.folder[data-id="f-band"] > .folder-head');
    await head.hover();
    const del = head.locator(".f-del");
    await del.click();
    await expect(del).toHaveAttribute("data-armed", "1");
    await expect(del).toContainText("Delete?");
    await expect(page.locator('.folder[data-id="f-band"]')).toHaveCount(1);
    expect(calls.trashed).toEqual([]);

    await del.click();
    await expect(page.locator('.folder[data-id="f-band"]')).toHaveCount(0);
    await expect(page.locator('.folder[data-id="f-live"]')).toHaveCount(0);
    await expect.poll(async () => (await trashItems(page)).sort()).toEqual([JOB_ID, SIBLING_JOB_ID].sort());
    await expect.poll(() => [...calls.trashed].sort()).toEqual([JOB_ID, SIBLING_JOB_ID].sort());
  });
});

test.describe("keyboard delete", () => {
  test("bins the focused library row, and nothing without one", async ({ page }) => {
    await seedFolders(page, [unsorted([JOB_ID, SIBLING_JOB_ID]), trashFolder([])]);
    await stubLibraryWrites(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await page.locator(`.cat-item[data-id="${JOB_ID}"] .cat-title`).click();
    await page.locator("body").focus();
    await page.keyboard.press("Delete");
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"] .cat-fav`).focus();
    await page.keyboard.press("Backspace");

    await expect.poll(() => trashItems(page)).toEqual([SIBLING_JOB_ID]);
  });

  test("bins nothing while a dialog is open, even with a row still focused", async ({ page }) => {
    await seedFolders(page, [unsorted([JOB_ID, SIBLING_JOB_ID]), trashFolder([])]);
    const calls = await stubLibraryWrites(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const fav = page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"] .cat-fav`);
    await fav.focus();
    // Shown the way the app shows it, without taking focus from the row.
    await page.evaluate(() => document.getElementById("aboutDialog").classList.remove("hidden"));
    await expect(page.locator("#aboutDialog")).toBeVisible();
    await expect(fav).toBeFocused();
    await page.keyboard.press("Delete");

    await page.waitForTimeout(300);
    expect(calls.trashed).toEqual([]);
    expect(await trashItems(page)).toEqual([]);
  });

  test("leaves the open song alone in Stage mode and in a dialog", async ({ page }) => {
    const calls = await stubLibraryWrites(page);
    await openStudio(page);

    await page.locator("#stageModeBtn").click();
    await expect(page.locator(".app")).toHaveClass(/stage-mode/);
    await page.keyboard.press("Delete");
    await page.keyboard.press("Escape");
    await expect(page.locator(".app")).not.toHaveClass(/stage-mode/);

    await page.locator("#settingsBtn").click();
    await expect(page.locator(".auto-delete-input")).toBeAttached();
    await page.keyboard.press("Backspace");

    expect(calls.trashed).toEqual([]);
    expect(await trashItems(page)).toEqual([]);
  });
});
