// When Add section cannot place a section it says why, and with no song open
// it does nothing.
import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID } from "./helpers.mjs";

// seed.py writes a 6 second fixture; these two sections cover all of it.
const FULL_TRACK = [
  { id: "s1", name: "Verse", start: 0, end: 3, color: "#4a7fff" },
  { id: "s2", name: "Chorus", start: 3, end: 6, color: "#ff7a59" },
];
const NO_ROOM_TEXT = "No room left. Shorten or delete a section.";
const TOO_SHORT_TEXT = "Loop too short for a section";
// Longer than the shortest loop, shorter than the shortest section.
const SHORT_LOOP = { start: "02.000", end: "02.300" };
const STUDIO_MODULE = "/js/job.js";

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function seed(page, sections) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "seeding sections").toBe(true);
}

async function armLoop(page, { start, end }) {
  await page.locator("#t-loop-end").fill(end);
  await page.locator("#t-loop-end").blur();
  await page.locator("#t-loop-start").fill(start);
  await page.locator("#t-loop-start").blur();
  await expect(page.locator("#t-loop")).toHaveClass(/active/);
}

const blockIds = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".section-block")].map((el) => el.dataset.id),
  );

test("Add on a fully covered track says there is no room", async ({ page }) => {
  await seed(page, FULL_TRACK);
  await openStudio(page);
  await expect(page.locator(".section-block")).toHaveCount(FULL_TRACK.length);

  await page.locator("#sectionsAddBtn").click();

  expect(await blockIds(page)).toEqual(["s1", "s2"]);
  await expect(page.locator("#sectionsSaveIndicator.notice")).toHaveText(NO_ROOM_TEXT);
});

test("Add on a loop shorter than a section says the loop is too short", async ({ page }) => {
  await seed(page, FULL_TRACK);
  await openStudio(page);
  await armLoop(page, SHORT_LOOP);

  await page.locator("#sectionsAddBtn").click();

  expect(await blockIds(page)).toEqual(["s1", "s2"]);
  await expect(page.locator("#sectionsSaveIndicator.notice")).toHaveText(TOO_SHORT_TEXT);
});

test("Add with no song open does nothing and says nothing", async ({ page }) => {
  await openStudio(page);
  // reset() is the studio's own close path, the one a re-import runs.
  await page.evaluate(async (path) => (await import(path)).reset(), STUDIO_MODULE);

  // The ribbon takes no pointer input with no song, but the button still
  // takes the keyboard.
  await page.locator("#sectionsAddBtn").focus();
  await page.keyboard.press("Enter");

  // Read at once: a notice hides itself after a few seconds but keeps its text.
  const indicator = page.locator("#sectionsSaveIndicator");
  expect(await indicator.textContent()).toBe("");
  await expect(indicator).toBeHidden();
});
