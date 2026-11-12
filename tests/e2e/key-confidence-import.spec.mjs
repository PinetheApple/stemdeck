// A running import paints the key ring through job.js, a separate path from opening
// a track; the e2e backend never separates, so its POST and event stream are stubbed.

import { test, expect } from "@playwright/test";
import { openInspectorTab, stubExportEndpoints, stubUpdateCheck, uiText } from "./helpers.mjs";

const IMPORT_ID = "e2e0c0ffee01";
const IMPORT_URL = "https://www.youtube.com/watch?v=e2e-import";
const KEY_CONFIDENCE = 64;

const frame = (keyConfidence) => ({ job_id: IMPORT_ID, status: "analyzing", key: "D min", scale: "Minor", key_confidence: keyConfidence });

async function importWithStates(page, states) {
  const last = states.at(-1);
  await page.route("**/api/jobs", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return route.fulfill({ json: { job_id: IMPORT_ID } });
  });
  await page.route(`**/api/jobs/${IMPORT_ID}`, (route) => route.fulfill({ json: last }));
  await page.route(`**/api/jobs/${IMPORT_ID}/events`, (route) => route.fulfill({
    contentType: "text/event-stream",
    body: states.map((state) => `data: ${JSON.stringify(state)}\n\n`).join(""),
  }));
  await stubExportEndpoints(page);
  await stubUpdateCheck(page, { available: false });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".cat-item").first().waitFor();
  await page.evaluate(async (url) => (await import("/js/job.js")).importFromUrl(url), IMPORT_URL);
  await openInspectorTab(page, "details");
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a running import's key confidence says what it measures", async ({ page }) => {
  await importWithStates(page, [frame(KEY_CONFIDENCE)]);
  const ring = page.locator("#summary-confidence");
  const meaning = await uiText(page, "meta.keyConfidence", { value: KEY_CONFIDENCE });
  await expect(ring).toHaveText(`${KEY_CONFIDENCE}%`);
  await expect(ring).toHaveAttribute("title", meaning);
  await expect(ring).toHaveAccessibleName(meaning);
});

test("a state with no key confidence clears the ring", async ({ page }) => {
  await importWithStates(page, [frame(KEY_CONFIDENCE), frame(null)]);
  await expect(page.locator("#summary-key")).toHaveText(/D/);
  await expect(page.locator("#summary-confidence")).toBeHidden();
});
