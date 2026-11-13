// The queue view's summary of a batch: its failed items, Retry failed, and what
// stays shown once the queue drains. Preview, imports and queue are stubbed.
import { test, expect } from "@playwright/test";
import { uiText } from "./helpers.mjs";
import {
  HTTP_FULL, LINE, PASTE, TICKED_BY_DEFAULT, linkItem, openBar, paste, pasteList, preview, queueButton, review,
  stubImports, stubPreview,
} from "./batchImport.mjs";

const FAILED_ID = "e2e0b0000003";
const RUNNING_ID = "e2e0b0000001";
const WAITING_ID = "e2e0b0000002";

/**
 * Queue three links, then let the third fail while the others are still in the
 * queue, and open the queue view. `retryStatus` answers a Retry of the failed job.
 */
async function queueWithFailure(page, { retryStatus = 200 } = {}) {
  await openBar(page);
  const titles = ["Build My Life", "Firm Foundation", "Same God"];
  const urls = [LINE.ok, LINE.other, LINE.inLibrary];
  await stubPreview(page, {
    ...preview(), playlists: [], items: urls.map((url, i) => linkItem(i + 1, url, "ok", { title: titles[i] })),
  });
  await stubImports(page);
  const queue = { queued: [WAITING_ID, FAILED_ID], running: true };
  const job = (id) => ({ job_id: id, status: "queued", title: id, source_url: LINE.ok });
  await page.route("**/api/queue", (route) => route.fulfill({
    json: {
      running: queue.running ? { ...job(RUNNING_ID), status: "processing", stage: "Separating", progress: 0.4 } : null,
      queued: queue.queued.map(job),
      paused: false,
    },
  }));
  await page.route("**/api/queue/events", (route) => route.abort());
  await page.route(`**/api/jobs/${FAILED_ID}`, (route) => route.fulfill({
    json: { job_id: FAILED_ID, status: "error", error_code: "source-unavailable", retryable: true, title: "Same God", source_url: LINE.inLibrary, source_kind: "link", stems: [], selected_stems: [] },
  }));
  const retries = [];
  await page.route(`**/api/jobs/${FAILED_ID}/retry`, (route) => {
    retries.push(route.request().url());
    return retryStatus === 200
      ? route.fulfill({ json: { job_id: FAILED_ID, status: "queued", title: "Same God", source_url: LINE.inLibrary } })
      : route.fulfill({ status: retryStatus, json: { detail: "The queue is full" } });
  });
  await paste(page, urls.join("\n"));
  await expect(queueButton(page)).toHaveText(await uiText(page, "batch.queue.other", { count: 3 }));
  await queueButton(page).click();
  await expect(review(page)).toHaveCount(0);

  const refresh = () => page.evaluate(async () => (await import("/js/queue.js")).refreshQueue());
  await refresh();
  await page.locator(".rail-queue").click();
  queue.queued = [WAITING_ID];
  await refresh();
  return { queue, refresh, retries };
}

const failedRow = (page) => page.locator(`.batch-failed-row[data-id="${FAILED_ID}"]`);

test("a failed item stays in the queue with its reason and Retry", async ({ page }) => {
  const { queue, refresh, retries } = await queueWithFailure(page);
  const failed = failedRow(page);
  await expect(failed.locator(".batch-failed-label")).toHaveText(await uiText(page, "importFail.reason.sourceUnavailable"));
  const head = page.locator(".batch-head");
  await expect(head).toContainText(await uiText(page, "batch.doneOf", { done: 0, total: 3 }));
  await expect(head).toContainText(await uiText(page, "batch.failedCount.one", { count: 1 }));
  await expect(head.locator(".batch-retry-failed")).toBeVisible();

  // The queue drains: the batch and its failure stay in view until dealt with.
  queue.running = false;
  queue.queued = [];
  await refresh();
  await expect(head).toBeVisible();
  await expect(failed).toBeVisible();
  await failed.locator(".batch-failed-retry").click();
  await expect.poll(() => retries.length).toBe(1);
});

test("Retry failed with nothing left out keeps the batch's count", async ({ page }) => {
  const { queue, refresh, retries } = await queueWithFailure(page, { retryStatus: HTTP_FULL });
  queue.running = false;
  queue.queued = [];
  await refresh();
  // A new list waits in the bar, reviewed but not queued: it has nothing left out to send.
  await paste(page, [LINE.ok, LINE.other].join("\n"));
  await expect(queueButton(page)).toBeEnabled();
  await page.keyboard.press("Escape");
  const head = page.locator(".batch-head");
  await head.locator(".batch-retry-failed").click();
  await expect.poll(() => retries.length).toBe(1);
  await expect(head).toContainText(await uiText(page, "batch.failedCount.one", { count: 1 }));
  await expect(failedRow(page)).toBeVisible();
});

test("a new batch starts with nothing left over from the last one", async ({ page }) => {
  await pasteList(page);
  await stubImports(page, [200, HTTP_FULL]);
  await queueButton(page).click();
  await expect(review(page).locator(".batch-item-retry").first()).toBeVisible();
  const leftOver = await page.evaluate(async (text) => {
    const { startLinkBatch } = await import("/js/batchImport.js");
    startLinkBatch(text);
    return (await import("/js/queue.js")).getBatch().notQueued;
  }, PASTE);
  expect(leftOver).toBe(0);
});

test("Retry failed in the queue sends again what the queue did not take", async ({ page }) => {
  await pasteList(page);
  const posts = await stubImports(page, [200, HTTP_FULL]);
  await page.route("**/api/queue", (route) => route.fulfill({
    json: { running: { job_id: "e2e0b0000001", status: "processing", stage: "Separating", progress: 0.4, title: "Build My Life", source_url: LINE.ok }, queued: [], paused: false },
  }));
  await page.route("**/api/queue/events", (route) => route.abort());
  await queueButton(page).click();
  await expect(review(page).locator(".batch-item-retry").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(async () => (await import("/js/queue.js")).refreshQueue());
  await page.locator(".rail-queue").click();

  const head = page.locator(".batch-head");
  await expect(head).toContainText(await uiText(page, "batch.notQueuedCount.other", { count: TICKED_BY_DEFAULT - 1 }));
  await head.locator(".batch-retry-failed").click();
  await expect.poll(() => posts.length).toBe(TICKED_BY_DEFAULT + 1);
});

test("clearing the chip while the batch is being sent leaves nothing broken", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await pasteList(page);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const posts = [];
  await page.route(/\/api\/jobs$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts.push(route.request().postDataJSON());
    await held;
    return route.fulfill({ json: { job_id: `e2e0b00000${String(posts.length).padStart(2, "0")}` } });
  });
  await queueButton(page).click();
  await expect.poll(() => posts.length).toBe(1);
  await page.locator("#fileClear").click();
  release();
  await expect.poll(() => posts.length).toBe(TICKED_BY_DEFAULT);
  await expect(page.locator('.cat-item[data-id="e2e0b0000001"]')).toBeVisible();
  expect(errors).toEqual([]);
});
