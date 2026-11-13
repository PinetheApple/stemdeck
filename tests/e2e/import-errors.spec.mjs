// What an import says when part or all of it fails: a refused queue start, a
// batch of files the server takes only some of, a playlist that skips tracks,
// and a lost connection. Each names what was left out and why, in words.
import { test, expect } from "@playwright/test";
import { JOB_ID, failureMessages, fixtureTrack, openStudio, uiText } from "./helpers.mjs";

const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLe2eskips";
const PLAYLIST_TITLE = "Skips";
const WAITING_ID = "e2e0feed0001";
const UPLOAD_IDS = ["e2e0feed0011", "e2e0feed0012", "e2e0feed0013"];
const FILE_NAMES = ["one.wav", "two.wav", "three.wav"];
const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const wav = (name) => ({ name, mimeType: "audio/wav", buffer: Buffer.from("RIFF0000WAVE") });

/** Answer each upload in turn with the next of `statuses`; record every one. */
async function stubUploads(page, statuses) {
  const posts = [];
  await page.route("**/api/jobs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const status = statuses[posts.length] ?? 200;
    const body = status === 200 ? { job_id: UPLOAD_IDS[posts.length] } : { detail: `refused ${status}` };
    posts.push(status);
    return route.fulfill({ status, json: body });
  });
  return posts;
}

/** Pick the files, then queue all three from the review list. */
async function submitFiles(page) {
  await page.locator("#fileInput").setInputFiles(FILE_NAMES.map(wav));
  const queue = page.locator("#batchReview .batch-queue");
  await expect(queue).toBeEnabled();
  await queue.click();
}

const reviewRow = (page, name) => page.locator("#batchReview .batch-item", { hasText: name });

test.describe("a batch of files", () => {
  test("goes past a file the server refuses, and names it", async ({ page }) => {
    await openStudio(page);
    // The review lists files by name: one, three, two.
    const posts = await stubUploads(page, [200, 422, 200]);
    await submitFiles(page);

    await expect.poll(() => posts.length).toBe(3);
    await expect(reviewRow(page, "three.wav")).toContainText("refused 422");
    await expect(reviewRow(page, "one.wav")).toHaveCount(0);
    await expect(reviewRow(page, "two.wav")).toHaveCount(0);
  });

  test("stops at a full queue, and names every file left out", async ({ page }) => {
    await openStudio(page);
    const posts = await stubUploads(page, [200, 503]);
    await submitFiles(page);

    const reason = await uiText(page, "upload.reasonQueueFull");
    await expect(reviewRow(page, "two.wav")).toContainText(reason);
    await expect(reviewRow(page, "three.wav")).toContainText(reason);
    await expect(reviewRow(page, "one.wav")).toHaveCount(0);
    expect(posts).toHaveLength(2);
  });
});

test("a lost connection reads as words, not as the browser's message", async ({ page }) => {
  await openStudio(page);
  await page.route("**/api/jobs", (route) =>
    route.request().method() === "POST" ? route.abort("connectionrefused") : route.fallback());
  await page.locator("#url").fill(YOUTUBE_URL);
  await page.locator("#submit").click();

  const error = page.locator("#error");
  await expect(error).toContainText(await uiText(page, "job.networkError"));
  await expect(error).not.toContainText(/failed to fetch/i);
});

test("the error box leaves Extract stems, the mixer and the transport uncovered", async ({ page }) => {
  await openStudio(page);
  await page.evaluate(async () => (await import("/js/job.js")).showError("Something to read"));
  const error = await page.locator("#error").boundingBox();
  const submit = await page.locator("#submit").boundingBox();
  const footer = await page.locator(".daw-footer").boundingBox();
  const mixer = await page.locator("#mixer").boundingBox();
  expect(error.y).toBeGreaterThanOrEqual(submit.y + submit.height);
  expect(error.y + error.height).toBeLessThanOrEqual(footer.y);
  expect(error.x).toBeGreaterThanOrEqual(mixer.x + mixer.width);
});

const playlistItem = (n, title, status) => ({
  input: PLAYLIST_URL, line: 1, url: `https://www.youtube.com/watch?v=skip${n}aaaaaa`, title, artist: null,
  duration_sec: status === "too_long" ? 9000 : 200, status, existing_job_id: null, replaces: null,
  playlist: { url: PLAYLIST_URL, title: PLAYLIST_TITLE, index: n },
});

/** The review's answer for the playlist: `rows` as [title, status]. */
function stubPlaylistReview(page, rows) {
  return page.route("**/api/import/preview", (route) => route.fulfill({
    json: {
      items: rows.map(([title, status], i) => playlistItem(i + 1, title, status)),
      playlists: [{ input: PLAYLIST_URL, line: 1, url: PLAYLIST_URL, title: PLAYLIST_TITLE, found: rows.length, unavailable: 0, truncated: false }],
      files: [],
      max_duration_sec: 1200,
      capacity_left: { links: 10, files: 10 },
    },
  }));
}

test("a playlist's review names each track it would leave out, and why", async ({ page }) => {
  await openStudio(page);
  await stubPlaylistReview(page, [["Old Song", "in_library"], ["Long Song", "too_long"], ["New Song", "ok"]]);

  await page.locator("#url").fill(PLAYLIST_URL);
  await page.locator("#submit").click();
  const row = (title) => page.locator("#batchReview .batch-item", { hasText: title });
  await expect(row("Old Song")).toContainText(await uiText(page, "batch.flag.inLibrary"));
  await expect(row("Long Song")).toContainText(await uiText(page, "batch.flag.tooLong", { minutes: 20 }));
  await expect(page.locator("#batchReview .batch-queue")).toHaveText(await uiText(page, "batch.queue.one", { count: 1 }));
});

test("a playlist already in the library offers nothing to queue", async ({ page }) => {
  await openStudio(page);
  await stubPlaylistReview(page, [["Old Song", "in_library"], ["Older Song", "in_library"]]);

  await page.locator("#url").fill(PLAYLIST_URL);
  await page.locator("#submit").click();
  await expect(page.locator("#batchReview .batch-item-check:checked")).toHaveCount(0);
  await expect(page.locator("#batchReview .batch-queue")).toBeDisabled();
});

test("a queue that will not start says so, and Start comes back", async ({ page }) => {
  const waiting = { job_id: WAITING_ID, status: "queued", title: "Waiting", source_url: YOUTUBE_URL };
  await page.route("**/api/queue", (route) => route.fulfill({ json: { running: null, queued: [waiting], paused: true } }));
  await page.route("**/api/queue/events", (route) => route.abort());
  await page.route("**/api/queue/start", (route) => route.fulfill({ status: 500, json: { detail: "no" } }));
  await openStudio(page);

  await page.locator(".rail-queue").click();
  const start = page.locator(".queue-start-btn");
  await start.click();

  await expect(start).toHaveText(await uiText(page, "queue.start"));
  await expect(start).toBeEnabled();
  expect(await failureMessages(page)).toContain(await uiText(page, "notif.queueStartFailed"));
});

const FAILED_ID = "e2e0fa11ed09";

/** The fixture song plus a failed link import the server still knows. */
const FAILED_LIBRARY = {
  folders: [
    { id: "f-unsorted", name: "Unsorted", items: [JOB_ID, FAILED_ID], color: null },
    { id: "trash", name: "Trash", items: [], color: null },
  ],
  tracks: {
    [JOB_ID]: fixtureTrack(JOB_ID, "E2E Fixture Track"),
    [FAILED_ID]: {
      ...fixtureTrack(FAILED_ID, YOUTUBE_URL),
      status: "error",
      sourceUrl: YOUTUBE_URL,
      sourceKind: "link",
      retryable: true,
    },
  },
};

const retryFailed = (page) =>
  page.evaluate(async (id) => (await import("/js/catalog.js")).retryFailedImport(id), FAILED_ID);

test.describe("retrying a failed import", () => {
  test("with no connection reads as words", async ({ page }) => {
    await openStudio(page, { catalog: FAILED_LIBRARY });
    await page.route(`**/api/jobs/${FAILED_ID}/retry`, (route) => route.abort("connectionrefused"));
    await retryFailed(page);

    const error = page.locator("#error");
    await expect(error).toContainText(await uiText(page, "job.networkError"));
    await expect(error).not.toContainText(/failed to fetch/i);
  });

  test("whose replacement import loses the connection reads as words", async ({ page }) => {
    await openStudio(page, { catalog: FAILED_LIBRARY });
    await page.route(`**/api/jobs/${FAILED_ID}/retry`, (route) =>
      route.fulfill({ status: 404, json: { detail: "job not found" } }));
    await page.route("**/api/jobs", (route) =>
      route.request().method() === "POST" ? route.abort("connectionrefused") : route.fallback());
    await retryFailed(page);

    const error = page.locator("#error");
    await expect(error).toContainText(await uiText(page, "job.networkError"));
    await expect(error).not.toContainText(/failed to fetch/i);
  });

  test("refused without a reason in words says so plainly", async ({ page }) => {
    await openStudio(page, { catalog: FAILED_LIBRARY });
    await page.route(`**/api/jobs/${FAILED_ID}/retry`, (route) =>
      route.fulfill({ status: 422, json: { detail: [{ loc: ["body"], msg: "field required" }] } }));
    await retryFailed(page);

    const error = page.locator("#error");
    await expect(error).toContainText(await uiText(page, "job.unexpectedError"));
    await expect(error).not.toContainText("object");
  });
});
