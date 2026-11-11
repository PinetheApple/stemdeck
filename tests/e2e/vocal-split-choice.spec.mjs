// Lead + Backing picked at import is kept with the song, so a reload before the
// import finishes still splits it when it opens (#43).
import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  openInspectorTab,
  seedLibrary,
  stubExportEndpoints,
  stubImportQueue,
  stubUpdateCheck,
} from "./helpers.mjs";

const JSON_TYPE = "application/json";
const JOB_URL = `**/api/jobs/${JOB_ID}`;
const SOURCE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const SPLITTING = "Splitting lead and backing vocals…";
const STARTED = Object.freeze({ state: "running", choice: "split", error: null, phase: "splitting", progress: 0.3 });
const NOT_STARTED = Object.freeze({ state: "none", choice: "combined", error: null });

const answer = (route, status, body) => route.fulfill({ status, contentType: JSON_TYPE, body: JSON.stringify(body) });

/** The fixture song as the server keeps it: the choice a PUT stored, and its split. */
async function stubSongServer(page) {
  const server = { job: {}, view: NOT_STARTED };
  const calls = { choices: [], starts: 0 };
  await page.route("**/api/jobs", (route) =>
    (route.request().method() === "POST" ? answer(route, 200, { job_id: JOB_ID }) : route.fallback()));
  await page.route(`${JOB_URL}/vocal-split/choice`, (route) => {
    const { choice } = route.request().postDataJSON();
    calls.choices.push(choice);
    server.job.vocal_split_choice = choice;
    return answer(route, 200, { job_id: JOB_ID });
  });
  await page.route(JOB_URL, async (route) => {
    const res = await route.fetch();
    return answer(route, res.status(), { ...(await res.json()), ...server.job });
  });
  await page.route(`${JOB_URL}/vocal-split`, (route) => {
    if (route.request().method() !== "POST") return answer(route, 200, server.view);
    calls.starts++;
    server.view = STARTED;
    return answer(route, 202, STARTED);
  });
  return calls;
}

async function importWithLeadAndBacking(page) {
  await seedLibrary(page);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page);
  const queue = await stubImportQueue(page, JOB_ID, "Importing Song");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor({ timeout: 20000 });
  await page.locator('.vocal-mode-btn[data-mode="split"]').click();
  await page.locator("#url").fill(SOURCE);
  await page.locator("#submit").click();
  await queue.run();
  return queue;
}

test("Lead + Backing chosen at import still splits the song after a reload", async ({ page }) => {
  const calls = await stubSongServer(page);
  const queue = await importWithLeadAndBacking(page);
  await expect.poll(() => calls.choices).toEqual(["split"]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await queue.settle();
  await page.locator(`.cat-item[data-id="${JOB_ID}"]`).first().click();
  await openInspectorTab(page, "details");

  await expect(page.locator("#vocalSplitMessage")).toHaveText(SPLITTING);
  expect(calls.starts).toBe(1);
});
