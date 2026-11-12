// What an import says when part or all of it fails: a refused queue start, a
// batch of files the server takes only some of, a playlist that skips tracks,
// and a lost connection. Each names what was left out and why, in words.
import { test, expect } from "@playwright/test";
import { failureMessages, openStudio, uiText } from "./helpers.mjs";

const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLe2eskips";
const PLAYLIST_TITLE = "Skips";
const WAITING_ID = "e2e0feed0001";
const UPLOAD_IDS = ["e2e0feed0011", "e2e0feed0012", "e2e0feed0013"];
const FILE_NAMES = ["one.wav", "two.wav", "three.wav"];
const YOUTUBE_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const PREVIEW = {
  playlist_title: PLAYLIST_TITLE,
  total_found: 3,
  will_queue: 1,
  skipped_unavailable: 0,
  skipped_too_long: 0,
  skipped_in_library: 2,
  capacity_left: 10,
  cap: 50,
  truncated: false,
  items: [],
};

const CREATED = {
  playlist_title: PLAYLIST_TITLE,
  jobs: [],
  queued: 0,
  skipped_unavailable: 0,
  skipped_too_long: 0,
  skipped_in_library: 1,
  skipped_no_capacity: 1,
  skipped: [
    { title: "Old Song", source_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", reason: "in_library" },
    { title: "Late Song", source_url: "https://www.youtube.com/watch?v=bbbbbbbbbbb", reason: "no_capacity" },
  ],
};

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

async function submitFiles(page) {
  await page.locator("#fileInput").setInputFiles(FILE_NAMES.map(wav));
  await page.locator("#submit").click();
}

test.describe("a batch of files", () => {
  test("goes past a file the server refuses, and names it", async ({ page }) => {
    await openStudio(page);
    const posts = await stubUploads(page, [200, 422, 200]);
    await submitFiles(page);

    await expect.poll(() => posts.length).toBe(3);
    const error = page.locator("#error");
    await expect(error).toContainText("two.wav (refused 422)");
    await expect(error).not.toContainText("one.wav");
  });

  test("stops at a full queue, and names every file left out", async ({ page }) => {
    await openStudio(page);
    const posts = await stubUploads(page, [200, 503]);
    await submitFiles(page);

    const reason = await uiText(page, "upload.reasonQueueFull");
    const error = page.locator("#error");
    await expect(error).toContainText(`two.wav (${reason})`);
    await expect(error).toContainText(`three.wav (${reason})`);
    expect(posts).toHaveLength(2);
  });
});

test("files dropped beside audio are named with their reason", async ({ page }) => {
  await openStudio(page);
  await page.locator("#fileInput").setInputFiles([
    wav("song.wav"),
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") },
  ]);

  const reason = await uiText(page, "upload.reasonNotAudio");
  await expect(page.locator("#error")).toContainText(`notes.txt (${reason})`);
  await expect(page.locator("#error")).not.toContainText("song.wav");
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

test("a playlist import names each track it left out, and why", async ({ page }) => {
  await openStudio(page);
  await page.route("**/api/playlist/preview", (route) => route.fulfill({ json: PREVIEW }));
  await page.route("**/api/playlist", (route) => route.fulfill({ json: CREATED }));

  await page.locator("#url").fill(PLAYLIST_URL);
  await page.locator("#submit").click();
  await expect(page.locator(".playlist-confirm")).toContainText(await uiText(page, "playlist.skip.inLibrary.other", { count: 2 }));
  await page.locator(".playlist-confirm-go").click();

  const inLibrary = await uiText(page, "playlist.reason.inLibrary");
  const full = await uiText(page, "playlist.reason.noCapacity");
  await expect.poll(() => failureMessages(page).then((m) => m[0] ?? "")).toContain(`Old Song (${inLibrary})`);
  expect((await failureMessages(page))[0]).toContain(`Late Song (${full})`);
});

test("a playlist already in the library says so instead of importing", async ({ page }) => {
  await openStudio(page);
  await page.route("**/api/playlist/preview", (route) =>
    route.fulfill({ json: { ...PREVIEW, will_queue: 0, skipped_in_library: 3 } }));

  await page.locator("#url").fill(PLAYLIST_URL);
  await page.locator("#submit").click();
  await expect(page.locator("#error")).toContainText(await uiText(page, "playlist.allInLibrary"));
  await expect(page.locator(".playlist-confirm")).toHaveCount(0);
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
