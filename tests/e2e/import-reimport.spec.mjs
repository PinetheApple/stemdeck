// Re-importing a song whose files are gone, and what opening a song does to the
// import box.
//
// Opening a song never imports anything by itself: an unavailable one asks
// first, and only the confirm button downloads it again. The restore then shows
// its stage and a Cancel, so a wait in the queue does not look stuck.
import { test, expect } from "@playwright/test";
import { JOB_ID, SIBLING_JOB_ID, SIBLING_TITLE, TRACK_TITLE, fixtureTrack, openStudio } from "./helpers.mjs";

const GONE_ID = "e2e0f00dface";
const GONE_TITLE = "Gone Song";
const GONE_URL = "https://www.youtube.com/watch?v=e2e0f00dfac";
const RESTORED_ID = "e2e0feedf00d";
const LINK_URL = "https://www.youtube.com/watch?v=e2e0cafebab";

const CATALOG = {
  folders: [
    { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, SIBLING_JOB_ID, GONE_ID], color: null },
    { id: "trash", name: "Trash", items: [], color: null },
  ],
  tracks: {
    [JOB_ID]: fixtureTrack(JOB_ID, TRACK_TITLE),
    [SIBLING_JOB_ID]: { ...fixtureTrack(SIBLING_JOB_ID, SIBLING_TITLE), sourceUrl: LINK_URL },
    [GONE_ID]: { ...fixtureTrack(GONE_ID, GONE_TITLE), status: "unavailable", sourceUrl: GONE_URL },
  },
};

const WAITING = { job_id: RESTORED_ID, status: "queued", stage: "Queued", progress: 0, title: GONE_TITLE };

/** Count the import POSTs, and keep the restored job waiting in a paused queue. */
async function stubRestore(page) {
  const posts = [];
  const cancels = [];
  await page.route("**/api/jobs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON());
    return route.fulfill({ json: { job_id: RESTORED_ID } });
  });
  await page.route(`**/api/jobs/${RESTORED_ID}/cancel`, (route) => {
    cancels.push(RESTORED_ID);
    return route.fulfill({ json: { job_id: RESTORED_ID, status: "cancelled" } });
  });
  await page.route(`**/api/jobs/${RESTORED_ID}/events`, (route) =>
    route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(WAITING)}\n\n` }));
  await page.route(`**/api/jobs/${RESTORED_ID}`, (route) => route.fulfill({ json: WAITING }));
  await page.route("**/api/queue", (route) =>
    route.fulfill({ json: { running: null, queued: [WAITING], paused: true } }));
  await page.route("**/api/queue/events", (route) => route.abort());
  return { posts, cancels };
}

const openGone = (page) =>
  page.evaluate(async (id) => (await import("/js/catalog.js")).loadTrackIntoStudio(id), GONE_ID);

const dialog = (page) => page.locator(".reimport-confirm");

test.describe("an unavailable song", () => {
  test("asks before importing, and Cancel leaves playback alone", async ({ page }) => {
    await openStudio(page, { catalog: CATALOG });
    const { posts } = await stubRestore(page);

    await openGone(page);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page)).toContainText(GONE_TITLE);
    expect(posts).toHaveLength(0);

    await dialog(page).locator(".reset-confirm-cancel").click();
    await expect(dialog(page)).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(0);
    await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
  });

  test("opened twice, asks once and imports once", async ({ page }) => {
    await openStudio(page, { catalog: CATALOG });
    const { posts } = await stubRestore(page);

    await openGone(page);
    await openGone(page);
    await expect(dialog(page)).toHaveCount(1);
    await dialog(page).locator(".playlist-confirm-go").click();

    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ url: GONE_URL, replaces: GONE_ID });
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(1);
  });

  test("a refused restore keeps the open song playing", async ({ page }) => {
    await openStudio(page, { catalog: CATALOG });
    await page.route("**/api/jobs", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({ status: 409, json: { detail: "that song is already being imported again" } });
    });

    await openGone(page);
    await dialog(page).locator(".playlist-confirm-go").click();

    await expect(page.locator("#error")).toBeVisible();
    await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
    await expect(page.locator("#t-time")).not.toHaveText(/\/\s*00:00\s*$/);
  });

  test("a confirmed restore shows where it waits, and can be cancelled", async ({ page }) => {
    await openStudio(page, { catalog: CATALOG });
    const { cancels } = await stubRestore(page);
    await page.evaluate(async () => (await import("/js/queue.js")).refreshQueue());

    await openGone(page);
    await dialog(page).locator(".playlist-confirm-go").click();

    const box = page.locator("#job");
    await expect(box).toBeVisible();
    await expect(page.locator("#job-title")).toHaveText(GONE_TITLE);
    await expect(page.locator("#job-detail")).toHaveText("Paused");
    const cancel = page.locator("#job-cancel");
    await expect(cancel).toBeVisible();
    await cancel.click();
    await expect.poll(() => cancels.length).toBe(1);
  });
});

/** The server's copy of the sibling came from a link, not the fixture's upload. */
async function stubLinkSibling(page) {
  await page.route(`**/api/jobs/${SIBLING_JOB_ID}`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const real = await (await route.fetch()).json();
    return route.fulfill({ json: { ...real, source_url: LINK_URL } });
  });
}

test.describe("the import box", () => {
  test("stays empty when a song from a link is opened", async ({ page }) => {
    await openStudio(page, { catalog: CATALOG });
    await stubLinkSibling(page);
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });

    await expect(page.locator("#url")).toHaveValue("");
    await expect(page.locator("#url")).toHaveAttribute("required", "");
  });

  test("keeps what the user typed when a song is opened", async ({ page }) => {
    await openStudio(page, { catalog: CATALOG });
    await page.locator("#url").fill(GONE_URL);
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).first().dblclick();
    await expect(page.locator("#title")).toHaveText(SIBLING_TITLE, { timeout: 15000 });

    await expect(page.locator("#url")).toHaveValue(GONE_URL);
  });
});
