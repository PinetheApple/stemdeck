// The footer readout keeps one format with and without a song, and goes back
// to zeros when the song closes instead of keeping the last song's times.
import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

const ZERO = "00:00";
const LOADED_FORMAT = /^\d{2}:\d{2}$/;
const STUDIO_MODULE = "/js/job.js";

const readout = async (page) => [
  await page.locator("#footer-time-elapsed").textContent(),
  await page.locator("#footer-time-total").textContent(),
];

test("the readout uses the loaded format before a song opens", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  expect(await readout(page)).toEqual([ZERO, ZERO]);
});

test("closing the song resets the readout to zeros", async ({ page }) => {
  await openStudio(page);
  await expect(page.locator("#footer-time-total")).toHaveText(LOADED_FORMAT);
  await expect(page.locator("#footer-time-total")).not.toHaveText(ZERO);

  // reset() is the studio's own close path, the one a re-import runs.
  await page.evaluate(async (path) => (await import(path)).reset(), STUDIO_MODULE);

  expect(await readout(page)).toEqual([ZERO, ZERO]);
});
