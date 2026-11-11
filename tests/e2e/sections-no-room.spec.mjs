// Add with no gap left used to return silently, so the button looked broken.
import { test, expect } from "@playwright/test";
import { openStudio, JOB_ID } from "./helpers.mjs";

// seed.py writes a 6 second fixture; these two sections cover all of it.
const FULL_TRACK = [
  { id: "s1", name: "Verse", start: 0, end: 3, color: "#4a7fff" },
  { id: "s2", name: "Chorus", start: 3, end: 6, color: "#ff7a59" },
];
const NO_ROOM_TEXT = "No room left. Shorten or delete a section.";

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function seed(page, sections) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "seeding sections").toBe(true);
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
