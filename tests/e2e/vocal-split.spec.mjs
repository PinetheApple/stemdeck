// The lead/backing vocal split in the Details pane (#43), with the split's
// endpoints stubbed. What the server does is tests/test_vocal_split_api.py.
import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio, openInspectorTab } from "./helpers.mjs";

const JSON_TYPE = "application/json";
const JOB_URL = `**/api/jobs/${JOB_ID}`;
const START_LABEL = "Split lead/backing";
const RETRY_LABEL = "Try again";
const QUEUED = "Waiting for an import to finish…";
const SPLITTING = "Splitting lead and backing vocals…";
const SPLIT_KIND = "vocalSplit";
const OUT_OF_MEMORY = "There was not enough memory to split the vocals. Close other apps, then try again.";

const answer = (route, status, body) => route.fulfill({ status, contentType: JSON_TYPE, body: JSON.stringify(body) });
const running = (phase, progress) => ({ state: "running", choice: "split", error: null, phase, progress });
const ended = (state, error = null) => ({ state, choice: "split", error });

/**
 * Stub the fixture song's split. `job` patches the song's own state (GET
 * /api/jobs/{id}), `view` is what GET .../vocal-split answers and
 * changes as the test goes; a POST starts a run as `started`.
 */
async function stubSplit(page, { job = {}, view = ended("none"), started = running("queued", 0) } = {}) {
  const server = { job, view };
  const calls = { starts: 0, cancels: 0, jobReads: 0 };
  const patched = (state) => (state.job_id === JOB_ID ? { ...state, ...server.job } : state);
  await page.route(JOB_URL, async (route) => {
    calls.jobReads++;
    const res = await route.fetch();
    return answer(route, res.status(), patched(await res.json()));
  });
  await page.route(`${JOB_URL}/vocal-split`, (route) => {
    if (route.request().method() !== "POST") return answer(route, 200, server.view);
    calls.starts++;
    server.view = started;
    return answer(route, 202, started);
  });
  await page.route(`${JOB_URL}/cancel`, (route) => {
    calls.cancels++;
    return answer(route, 200, { status: "done" });
  });
  return { server, calls };
}

async function openDetails(page, options) {
  const stub = await stubSplit(page, options);
  await openStudio(page);
  await openInspectorTab(page, "details");
  return stub;
}

async function reopen(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
  await openInspectorTab(page, "details");
}

const card = (page) => page.locator("#vocalSplitCard");
const startButton = (page) => page.locator("#vocalSplitStart");
const cancelButton = (page) => page.locator("#vocalSplitCancel");
const message = (page) => page.locator("#vocalSplitMessage");
const progress = (page) => page.locator("#vocalSplitProgress");
const percent = (page) => page.locator("#vocalSplitPercent");
const splitNotices = (page) => page.evaluate(async (kind) =>
  (await import("/js/notifications.js")).getFailures().filter((f) => f.kind === kind).map((f) => f.message), SPLIT_KIND);

test.describe("splitting lead and backing vocals on demand", () => {
  test("a finished song offers the split, shows its progress, and Cancel stops it", async ({ page }) => {
    const { server, calls } = await openDetails(page);
    await expect(startButton(page)).toHaveText(START_LABEL);
    await expect(message(page)).toBeHidden();

    await startButton(page).click();
    await expect(message(page)).toHaveText(QUEUED);
    expect(calls.starts).toBe(1);
    await expect(startButton(page)).toBeHidden();

    server.view = running("splitting", 0.4);
    await expect(message(page)).toHaveText(SPLITTING);
    await expect(percent(page)).toHaveText("40%");

    await cancelButton(page).click();
    expect(calls.cancels).toBe(1);
    server.view = ended("cancelled");
    await expect(progress(page)).toBeHidden();
    await expect(startButton(page)).toHaveText(START_LABEL);
  });

  test("a failed split says why, and Try again starts it again", async ({ page }) => {
    const failed = { vocal_split: "error", vocal_split_error: "out_of_memory", vocal_split_choice: "split" };
    const { server, calls } = await openDetails(page, { job: failed, view: ended("error", "out_of_memory") });
    await expect(message(page)).toHaveText(OUT_OF_MEMORY);
    await expect(startButton(page)).toHaveText(RETRY_LABEL);

    await startButton(page).click();
    expect(calls.starts).toBe(1);
    await expect(progress(page)).toBeVisible();

    const readsBefore = calls.jobReads;
    server.job = { vocal_split: "done", vocal_split_error: null };
    server.view = ended("done");
    await expect(card(page)).toBeHidden();
    // The song reopens, so its new lanes come in.
    await expect.poll(() => calls.jobReads).toBeGreaterThan(readsBefore);
  });

  test("a song already split offers nothing", async ({ page }) => {
    await openDetails(page, { job: { vocal_split: "done", vocal_split_choice: "split" }, view: ended("done") });
    await expect(page.locator(".inspector-card.details-song")).toBeVisible();
    await expect(card(page)).toBeHidden();
  });

  test("the choice stored with the song starts its split, and a reload follows it", async ({ page }) => {
    const requested = { vocal_split: "none", vocal_split_choice: "split" };
    const { server, calls } = await openDetails(page, { job: requested, started: running("splitting", 0.25) });
    await expect(message(page)).toHaveText(SPLITTING);
    await expect(percent(page)).toHaveText("25%");
    expect(calls.starts).toBe(1);

    server.job = { ...requested, vocal_split: "running" };
    await reopen(page);
    await expect(percent(page)).toHaveText("25%");
    expect(calls.starts).toBe(1);
  });

  test("a split started on its own that fails is notified, and says why", async ({ page }) => {
    const requested = { vocal_split: "none", vocal_split_choice: "split" };
    const { server } = await openDetails(page, { job: requested, started: running("splitting", 0.1) });
    await expect(progress(page)).toBeVisible();

    server.view = ended("error", "out_of_memory");
    await expect(message(page)).toHaveText(OUT_OF_MEMORY);
    await expect.poll(() => splitNotices(page)).toEqual([OUT_OF_MEMORY]);
  });

  test("a split the user started that fails stays on its card", async ({ page }) => {
    const { server } = await openDetails(page, { started: running("splitting", 0.1) });
    await startButton(page).click();
    await expect(progress(page)).toBeVisible();

    server.view = ended("error", "out_of_memory");
    await expect(message(page)).toHaveText(OUT_OF_MEMORY);
    expect(await splitNotices(page)).toEqual([]);
  });
});
