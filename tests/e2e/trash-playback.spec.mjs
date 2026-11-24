// Trashed songs never play from Up Next or setlists. The server's Trash and
// permanent delete are stubbed so the shared fixture jobs stay out of the Trash.

import { test, expect } from "@playwright/test";

import {
  chooseFromSongMenu,
  JOB_ID,
  JOB_LIST_URL,
  SIBLING_JOB_ID,
  SIBLING_TITLE,
  TRACK_TITLE,
  fixtureTrack,
  openBrowse,
  openInspectorTab,
  seedCatalogState,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";

const UP_NEXT_KEY = "stemdeck.upNext";
// What follows a click is an async load; an assertion that nothing opened
// made before it settles would pass on a page that never got the chance.
const SETTLE_MS = 500;
// The window only syncs again on focus once this long has passed since the last.
const PAST_FOCUS_SYNC_WAIT_MS = 16_000;
const LOAD_TIMEOUT_MS = 15_000;
const SETLISTS_PATH = "/api/setlists";
const SIBLING_JOB_URL = new RegExp(`/api/jobs/${SIBLING_JOB_ID}$`);
const TRASH_CHANGE_EVENT = "tracktrash";

test.afterEach(async ({ request }) => {
  const res = await request.get(SETLISTS_PATH);
  for (const setlist of await res.json()) await request.delete(`${SETLISTS_PATH}/${setlist.id}`);
});

/** Both fixture songs, the sibling already in the Trash when `trashed`, and Up Next as stored. */
async function openApp(page, { trashed = false, upNext = [] } = {}) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: trashed ? [JOB_ID] : [JOB_ID, SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: trashed ? [SIBLING_JOB_ID] : [], color: null },
    ],
    tracks: {
      [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE),
    },
  });
  await page.addInitScript(({ key, ids }) => localStorage.setItem(key, JSON.stringify(ids)), { key: UP_NEXT_KEY, ids: upNext });
  await stubUpdateCheck(page);
  const server = await stubServerTrash(page, { trashed: trashed ? [SIBLING_JOB_ID] : [] });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(libraryRow(page, JOB_ID)).toBeVisible();
  return server;
}

const libraryRow = (page, id) => page.locator(`#catalogList .cat-item[data-id="${id}"]`).first();
const upNextRow = (page, id) => page.locator(`#upNextList .upnext-row[data-id="${id}"]`);
const setlistRow = (page, id) => page.locator(`#browseResults .setlist-song[data-id="${id}"]`);
const setlistPlay = (page) => page.locator("#browseResults .browse-setlist-play");
const SETLIST_NAME = "Gig";
const storedUpNext = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), UP_NEXT_KEY);
const createSetlist = (request, songIds) => request.post(SETLISTS_PATH, { data: { name: SETLIST_NAME, song_ids: songIds } });

async function rowAction(page, id, selector) {
  const row = libraryRow(page, id);
  await row.hover();
  await row.locator(selector).click();
}

async function openSetlist(page) {
  await openBrowse(page);
  await page.locator('#browseNav .browse-nav-btn[data-view^="setlist:"]', { hasText: SETLIST_NAME }).click();
  await expect(page.locator("#browseResults .browse-head h2")).toHaveText(SETLIST_NAME);
}

async function closeBrowse(page) {
  await page.locator("#browseCloseBtn").click();
  await expect(page.locator("#browseLibrary")).toBeHidden();
}

/** Restore the song from the Trash, then go back to the sidebar. */
async function restoreFromTrash(page, id) {
  await openBrowse(page, "trash");
  const row = page.locator(`#browseResults .cat-item.in-trash[data-id="${id}"]`);
  await row.locator(".cat-restore").click();
  await expect(row).toHaveCount(0);
  await closeBrowse(page);
  await expect(libraryRow(page, id)).toBeVisible();
}

/** Count the songs the studio opens from here on. */
async function recordOpens(page) {
  await page.evaluate(() => {
    window.__opened = [];
    document.addEventListener("trackopen", function onTrackOpenForTest(e) {
      window.__opened.push(e.detail?.id);
    });
  });
}

const opened = (page) => page.evaluate(() => window.__opened);

/** Start listening for the app's next trash change; the returned call waits until it lands. */
async function nextTrashChange(page) {
  await page.evaluate((type) => {
    window.__trashChanged = new Promise(function onTrashChangeForTest(resolve) {
      document.addEventListener(type, resolve, { once: true });
    });
  }, TRASH_CHANGE_EVENT);
  return () => page.evaluate(() => window.__trashChanged.then(() => true));
}

/** Bring the window back into view past the focus-sync wait, and return once the list was read. */
async function syncOnFocus(page) {
  await page.clock.fastForward(PAST_FOCUS_SYNC_WAIT_MS);
  const listRead = page.waitForResponse((r) => JOB_LIST_URL.test(r.url()));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await listRead;
}

test.describe("Up Next", () => {
  test("a song trashed here leaves it for good", async ({ page }) => {
    await openApp(page);
    await rowAction(page, SIBLING_JOB_ID, ".cat-upnext");
    await openInspectorTab(page, "upnext");
    await expect(upNextRow(page, SIBLING_JOB_ID)).toBeVisible();
    await expect(page.locator("#t-next")).toBeEnabled();

    await chooseFromSongMenu(page, libraryRow(page, SIBLING_JOB_ID), "Move to Trash");
    await expect(upNextRow(page, SIBLING_JOB_ID)).toHaveCount(0);
    await expect(page.locator("#upNextCount")).toBeHidden();
    await expect(page.locator("#t-next")).toBeDisabled();
    await expect.poll(() => storedUpNext(page)).toEqual([]);

    await restoreFromTrash(page, SIBLING_JOB_ID);
    await expect(upNextRow(page, SIBLING_JOB_ID)).toHaveCount(0);
    expect(await storedUpNext(page)).toEqual([]);
  });

  test("a trashed song left in the stored list is dropped when the app starts", async ({ page }) => {
    await openApp(page, { trashed: true, upNext: [SIBLING_JOB_ID, JOB_ID] });
    await openInspectorTab(page, "upnext");
    await expect(page.locator("#upNextList .upnext-row")).toHaveCount(1);
    await expect(upNextRow(page, JOB_ID)).toBeVisible();
    await expect.poll(() => storedUpNext(page)).toEqual([JOB_ID]);

    await restoreFromTrash(page, SIBLING_JOB_ID);
    await expect(upNextRow(page, SIBLING_JOB_ID)).toHaveCount(0);
  });
});

test("a song trashed on another device leaves Up Next and greys in its setlist, until restored there", async ({ page, request }) => {
  await createSetlist(request, [SIBLING_JOB_ID]);
  await page.clock.install();
  const server = await openApp(page, { upNext: [SIBLING_JOB_ID] });
  await openInspectorTab(page, "upnext");
  await openSetlist(page);
  await expect(upNextRow(page, SIBLING_JOB_ID)).toBeVisible();
  await expect(setlistPlay(page)).toBeEnabled();

  server.trashed.add(SIBLING_JOB_ID);
  await syncOnFocus(page);
  await expect(upNextRow(page, SIBLING_JOB_ID)).toHaveCount(0);
  await expect(setlistRow(page, SIBLING_JOB_ID)).toHaveClass(/in-trash/);
  await expect(setlistPlay(page)).toBeDisabled();

  server.trashed.delete(SIBLING_JOB_ID);
  await syncOnFocus(page);
  await expect(setlistRow(page, SIBLING_JOB_ID)).not.toHaveClass(/in-trash/);
  await expect(setlistPlay(page)).toBeEnabled();
  await expect(upNextRow(page, SIBLING_JOB_ID)).toHaveCount(0);
});

test("a trash from another device keeps a setlist name being typed, and greys the row once it is saved", async ({ page, request }) => {
  await createSetlist(request, [SIBLING_JOB_ID]);
  await page.clock.install();
  const server = await openApp(page);
  await openSetlist(page);
  await page.locator("#browseResults .browse-setlist-rename").click();
  const name = page.locator(".setlist-rename-dialog .folder-editor-name");
  await name.fill("Encore");

  server.trashed.add(SIBLING_JOB_ID);
  const trashLanded = await nextTrashChange(page);
  await syncOnFocus(page);
  await trashLanded();
  await expect(name).toHaveValue("Encore");
  await name.press("Enter");
  await expect(page.locator("#browseResults .browse-head h2")).toHaveText("Encore");
  await expect(setlistRow(page, SIBLING_JOB_ID)).toHaveClass(/in-trash/);
});

test.describe("a setlist", () => {
  test("keeps a trashed song's row, greyed, and it does not open", async ({ page, request }) => {
    await createSetlist(request, [JOB_ID, SIBLING_JOB_ID]);
    await openApp(page, { trashed: true });
    await recordOpens(page);
    await openSetlist(page);
    const row = setlistRow(page, SIBLING_JOB_ID);
    await expect(row).toHaveClass(/in-trash/);
    await expect(row.locator(".cat-sub")).toHaveText("In the Trash");
    await expect(setlistRow(page, JOB_ID)).not.toHaveClass(/in-trash/);
    await expect(page.locator("#browseResults .browse-head-count")).toHaveText("2 songs");

    await row.hover();
    await expect(row.locator(".row-play")).toBeHidden();
    await row.dblclick();
    await row.click();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(SETTLE_MS);
    expect(await opened(page)).toEqual([]);
  });

  test("Play skips a trashed song, and leaves it out of Up Next", async ({ page, request }) => {
    await createSetlist(request, [SIBLING_JOB_ID, JOB_ID]);
    await openApp(page, { trashed: true });
    await recordOpens(page);
    await openSetlist(page);
    await setlistPlay(page).click();
    // The opens in order, not the title: the sibling is short enough that
    // Up Next has already moved past it by the time a title is read.
    await expect.poll(() => opened(page), { timeout: LOAD_TIMEOUT_MS }).toEqual([JOB_ID]);
    await openInspectorTab(page, "upnext");
    await expect(page.locator("#upNextList .upnext-row")).toHaveCount(0);
  });

  test("with every song trashed, Play is off until one is restored", async ({ page, request }) => {
    await createSetlist(request, [SIBLING_JOB_ID]);
    await openApp(page, { trashed: true });
    await openSetlist(page);
    await expect(setlistPlay(page)).toBeDisabled();

    await restoreFromTrash(page, SIBLING_JOB_ID);
    await openSetlist(page);
    const row = setlistRow(page, SIBLING_JOB_ID);
    await expect(row).not.toHaveClass(/in-trash/);
    await expect(setlistPlay(page)).toBeEnabled();
    await row.dblclick();
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: LOAD_TIMEOUT_MS });
  });

  test("loses a trashed song's row once the Trash is emptied", async ({ page, request }) => {
    await createSetlist(request, [JOB_ID, SIBLING_JOB_ID]);
    const deleted = await stubPermanentDelete(page);
    await openApp(page, { trashed: true });
    await openSetlist(page);
    await expect(setlistRow(page, SIBLING_JOB_ID)).toBeVisible();

    await openBrowse(page, "trash");
    await page.locator("#browseEmptyTrash").click();
    await page.locator("#browseEmptyTrash").click();
    await expect.poll(() => [...deleted]).toEqual([SIBLING_JOB_ID]);
    await openSetlist(page);
    await expect(setlistRow(page, JOB_ID)).toBeVisible();
    await expect(setlistRow(page, SIBLING_JOB_ID)).toHaveCount(0);
  });
});

/** Answer the sibling's DELETE here, and serve setlists as the server does after it. */
async function stubPermanentDelete(page) {
  const deleted = new Set();
  await page.route(SIBLING_JOB_URL, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleted.add(SIBLING_JOB_ID);
    return route.fulfill({ json: { job_id: SIBLING_JOB_ID, status: "deleted" } });
  });
  await page.route((url) => url.pathname === SETLISTS_PATH, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const res = await route.fetch();
    const served = (await res.json()).map((s) => ({ ...s, song_ids: s.song_ids.filter((id) => !deleted.has(id)) }));
    return route.fulfill({ response: res, json: served });
  });
  return deleted;
}
