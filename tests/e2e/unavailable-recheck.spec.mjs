// A song marked unavailable is asked about again before anything acts on the mark.
// The mark can be stale: another server answered for a while, or this one was
// restarted. Only a server that says the song is gone earns a re-import.

import { test, expect } from "@playwright/test";

import {
  JOB_ID,
  TRACK_TITLE,
  fixtureTrack,
  readCatalogState,
  seedCatalogState,
  stubServerTrash,
  stubUpdateCheck,
} from "./helpers.mjs";

const GONE_ID = "e2e0f00dface";
const LINK = "https://www.youtube.com/watch?v=e2e0f00dfac";
const NEW_ID = "e2e0feedf00d";
const LIST_PATH = "/api/jobs";
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const OFFLINE_TEXT = "Can't reach StemDeck";
const LOAD_FAILED_TEXT = "This track's audio could not be loaded.";
// A negative assertion needs the reconcile and its render to have had their turn.
const SETTLE_MS = 500;
const PLAY_TIMEOUT_MS = 20000;

const marked = (id, title) => ({ ...fixtureTrack(id, title), status: "unavailable", sourceUrl: LINK });
const row = (page, id) => page.locator(`#catalogList .cat-item[data-id="${id}"]`).first();
const prompt = (page) => page.locator(".reimport-confirm");
const storedStatus = async (page, id) => (await readCatalogState(page))?.tracks?.[id]?.status;
const jobUrl = (id) => new RegExp(`/api/jobs/${id}$`);

async function seed(page, tracks) {
  await seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: Object.keys(tracks), color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks,
    seedOnce: true,
  });
  await stubUpdateCheck(page);
}

/** Load the page and return once the startup sync has read the list and settled. */
async function open(page) {
  const listRead = page.waitForResponse(
    (r) => new URL(r.url()).pathname === LIST_PATH && r.request().method() === "GET",
  );
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await listRead;
  await page.waitForTimeout(SETTLE_MS);
}

/** Record import POSTs, answering each with a new job. */
async function recordImports(page) {
  const posts = [];
  await page.route(/\/api\/jobs$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { job_id: NEW_ID } });
  });
  return posts;
}

/** Answer the song's own state request with an HTTP error. */
async function answerJobWith(page, id, status) {
  await page.route(jobUrl(id), (route) => route.fulfill({
    status,
    json: { detail: "stubbed" },
  }));
}

/** The fixture song marked unavailable, with the startup sync's list leaving it out so the mark survives. */
async function openWithStaleMark(page) {
  await seed(page, { [JOB_ID]: marked(JOB_ID, TRACK_TITLE) });
  await stubServerTrash(page, { hidden: [JOB_ID] });
  await open(page);
  expect(await storedStatus(page, JOB_ID)).toBe("unavailable");
}

test.describe("opening a song marked unavailable", () => {
  test("plays it without a re-import once the server has it again", async ({ page }) => {
    const posts = await recordImports(page);
    await openWithStaleMark(page);

    await row(page, JOB_ID).dblclick();

    await expect(page.locator("#t-time")).not.toHaveText(/\/\s*00:00\s*$/, { timeout: PLAY_TIMEOUT_MS });
    await expect(prompt(page)).toHaveCount(0);
    expect(posts).toHaveLength(0);
    expect(await storedStatus(page, JOB_ID)).toBe("done");
    await expect(row(page, JOB_ID)).not.toHaveClass(/unavailable/);
  });

  test("offers the re-import when the server says it is gone", async ({ page }) => {
    await seed(page, { [GONE_ID]: marked(GONE_ID, "Gone") });
    await answerJobWith(page, GONE_ID, HTTP_NOT_FOUND);
    await open(page);

    await row(page, GONE_ID).dblclick();

    await expect(prompt(page)).toBeVisible();
    expect(await storedStatus(page, GONE_ID)).toBe("unavailable");
  });

  test("says the server can't be reached, and keeps the mark, when it does not answer", async ({ page }) => {
    await openWithStaleMark(page);
    await page.route(jobUrl(JOB_ID), (route) => route.abort("connectionrefused"));

    await row(page, JOB_ID).dblclick();

    await expect(page.locator("#error")).toContainText(OFFLINE_TEXT);
    await page.waitForTimeout(SETTLE_MS);
    await expect(prompt(page)).toHaveCount(0);
    expect(await storedStatus(page, JOB_ID)).toBe("unavailable");
  });

  test("says the song could not be loaded, and keeps the mark, when the server fails", async ({ page }) => {
    await openWithStaleMark(page);
    await answerJobWith(page, JOB_ID, HTTP_SERVER_ERROR);

    await row(page, JOB_ID).dblclick();

    await expect(page.locator("#error")).toContainText(LOAD_FAILED_TEXT);
    await expect(page.locator("#error")).not.toContainText(OFFLINE_TEXT);
    await page.waitForTimeout(SETTLE_MS);
    await expect(prompt(page)).toHaveCount(0);
    expect(await storedStatus(page, JOB_ID)).toBe("unavailable");
  });
});

test("a startup sync the server never answers leaves every song as it was", async ({ page }) => {
  await seed(page, { [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE) });
  await page.route(/\/api\/jobs(\?.*)?$/, (route) => route.abort("connectionrefused"));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS);

  expect(await storedStatus(page, JOB_ID)).toBe("done");
  await expect(row(page, JOB_ID)).not.toHaveClass(/unavailable/);
  await expect(prompt(page)).toHaveCount(0);
});

test("an import settling while the server does not answer about it stays as it was", async ({ page }) => {
  await seed(page, { [JOB_ID]: { ...fixtureTrack(JOB_ID, TRACK_TITLE), status: "processing" } });
  const asked = page.waitForRequest(jobUrl(JOB_ID));
  await page.route(jobUrl(JOB_ID), (route) => route.abort("connectionrefused"));
  await open(page);
  await asked;
  await page.waitForTimeout(SETTLE_MS);

  expect(await storedStatus(page, JOB_ID)).toBe("processing");
});

test.describe("Sync again", () => {
  async function syncAgain(page) {
    await page.locator("#settingsBtn").click();
    await page.locator('.settings-tab[data-tab="registry"]').click();
    await page.locator('.settings-pane[data-pane="registry"] .library-editor-sync').click();
  }

  test("re-imports only the songs the server says are gone", async ({ page }) => {
    const posts = await recordImports(page);
    await seed(page, { [JOB_ID]: marked(JOB_ID, TRACK_TITLE), [GONE_ID]: marked(GONE_ID, "Gone") });
    await stubServerTrash(page, { hidden: [JOB_ID] });
    await answerJobWith(page, GONE_ID, HTTP_NOT_FOUND);
    await open(page);

    await syncAgain(page);

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ url: LINK, replaces: GONE_ID });
    expect(await storedStatus(page, JOB_ID)).toBe("done");
  });

  test("leaves a song alone when the server does not answer about it", async ({ page }) => {
    const posts = await recordImports(page);
    await seed(page, { [JOB_ID]: marked(JOB_ID, TRACK_TITLE) });
    await stubServerTrash(page, { hidden: [JOB_ID] });
    await page.route(jobUrl(JOB_ID), (route) => route.abort("connectionrefused"));
    await open(page);

    await syncAgain(page);

    await page.waitForTimeout(SETTLE_MS);
    expect(posts).toHaveLength(0);
    expect(await storedStatus(page, JOB_ID)).toBe("unavailable");
  });
});
