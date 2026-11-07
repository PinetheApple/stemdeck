// The phone's Lead + Backing import says the stems are ready only once the
// split has finished, and says so when it did not (#43). The split answers
// 202 at once now, so taking that answer for the result told the user too soon.
import { test, expect } from "@playwright/test";

const JSON_TYPE = "application/json";
const NEW_JOB = "e2e0f00dfeed";
const SOURCE = "https://example.com/song.mp3";
const READY = "Stems ready!";
const SPLIT_FAILED = "Stems ready (lead/backing split didn't work this time).";

const answer = (route, status, body) => route.fulfill({ status, contentType: JSON_TYPE, body: JSON.stringify(body) });
const running = (progress) => ({ state: "running", choice: "split", error: null, phase: "splitting", progress });
const ended = (state, error = null) => ({ state, choice: "split", error });

/** A new import that is done at once; `server.view` is the split's state. */
async function stubImport(page) {
  const server = { view: running(0) };
  const calls = { starts: 0 };
  await page.route("**/api/jobs", (route) =>
    (route.request().method() === "POST" ? answer(route, 200, { job_id: NEW_JOB }) : route.fallback()));
  await page.route(`**/api/jobs/${NEW_JOB}/events`, (route) => answer(route, 500, {}));
  await page.route(`**/api/jobs/${NEW_JOB}`, (route) =>
    answer(route, 200, { job_id: NEW_JOB, status: "done", progress: 1, stage: "Done" }));
  await page.route(`**/api/jobs/${NEW_JOB}/vocal-split`, (route) => {
    if (route.request().method() !== "POST") return answer(route, 200, server.view);
    calls.starts++;
    return answer(route, 202, running(0));
  });
  return { server, calls };
}

async function importWithSplit(page) {
  await page.goto("/?ui=mobile", { waitUntil: "domcontentloaded" });
  await page.locator('[data-action="tab"][data-tab="extract"]').first().click();
  await page.locator('[data-action="vocalmode"][data-mode="split"]').click();
  await page.locator("#ext-url").fill(SOURCE);
  await page.locator('[data-action="split"]').click();
}

const progressCard = (page) => page.locator(".progress-card");
const toastEl = (page) => page.locator("#m-toast");

test.describe("phone: Lead + Backing import", () => {
  test("waits for the split before saying the stems are ready", async ({ page }) => {
    const { server, calls } = await stubImport(page);
    await importWithSplit(page);

    await expect(progressCard(page)).toContainText("Splitting lead/backing vocals…");
    expect(calls.starts).toBe(1);
    server.view = running(0.4);
    await expect(page.locator(".progress-pct")).toHaveText("40%");
    await expect(page.getByText(READY, { exact: true })).toHaveCount(0);

    server.view = ended("done");
    await expect(toastEl(page)).toHaveText(READY);
  });

  test("says so when the split fails", async ({ page }) => {
    const { server } = await stubImport(page);
    await importWithSplit(page);
    await expect(progressCard(page)).toContainText("Splitting lead/backing vocals…");

    server.view = ended("error", "out_of_memory");
    await expect(toastEl(page)).toHaveText(SPLIT_FAILED);
  });
});
