// The footer's Loop names what loops, and its options set the loop's edges at
// the playhead or clear it. L, I and O keep working as before.
import { test, expect } from "@playwright/test";
import { openStudio, openLoopOptions, JOB_ID, TALL_WINDOW } from "./helpers.mjs";

const VERSE = { id: "s1", name: "Verse", start: 1, end: 2, color: "#4a7fff" };
const CHORUS = { id: "s2", name: "Chorus", start: 4, end: 5, color: "#2ab8e8" };

test.use({ viewport: TALL_WINDOW });

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function seed(page, sections) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "seeding sections").toBe(true);
}

const loopName = (page) => page.locator("#t-loop-name");
const loopButton = (page) => page.locator("#t-loop");
const block = (page, id) => page.locator(`.section-block[data-id="${id}"]`);
const field = (page, edge) => page.locator(`#t-loop-${edge}`);

async function loopSection(page, id) {
  await block(page, id).hover();
  await block(page, id).locator(".section-loop").click();
}

/** Arm a loop that is no section's span, through the exact fields. */
async function loopRange(page, start, end) {
  await openLoopOptions(page);
  await field(page, "end").fill(end);
  await field(page, "end").blur();
  await field(page, "start").fill(start);
  await field(page, "start").blur();
}

test.describe("footer Loop", () => {
  test("names the looping section, then Region for any other range, and Loop when off", async ({ page }) => {
    // Wide enough for its loop button, which a block narrower than about 100px drops.
    await seed(page, [{ ...VERSE, end: 3 }]);
    await openStudio(page);
    await expect(loopName(page)).toHaveText("Loop");

    await loopSection(page, "s1");
    await expect(loopName(page)).toHaveText("Verse");
    await expect(loopButton(page)).toHaveClass(/active/);

    await loopRange(page, "00.500", "03.000");
    await expect(loopName(page)).toHaveText("Region");

    await page.locator("#t-loop").click();
    await expect(loopName(page)).toHaveText("Loop");
    await expect(loopButton(page)).not.toHaveClass(/active/);
  });

  test("Set start here and Set end here take the playhead and turn Loop on", async ({ page }) => {
    await seed(page, [VERSE, CHORUS]);
    await openStudio(page);

    await block(page, "s1").click();
    await openLoopOptions(page);
    await page.locator("#t-loop-start-here").click();
    await expect(field(page, "start")).toHaveValue("01.000");
    await expect(loopButton(page)).toHaveClass(/active/);

    await block(page, "s2").click();
    await openLoopOptions(page);
    await page.locator("#t-loop-end-here").click();
    await expect(field(page, "end")).toHaveValue("04.000");
    await expect(loopName(page)).toHaveText("Region");
  });

  test("Clear loop turns Loop off and puts the bounds back", async ({ page }) => {
    await openStudio(page);
    await loopRange(page, "00.500", "05.000");
    await expect(loopButton(page)).toHaveClass(/active/);

    await page.locator("#t-loop-clear").click();

    await expect(loopButton(page)).not.toHaveClass(/active/);
    await expect(field(page, "start")).toHaveValue("01.500");
    await expect(field(page, "end")).toHaveValue("03.000");
    await expect(loopName(page)).toHaveText("Loop");
  });

  test("L toggles the loop; I and O set its edges only while it is on", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);
    await block(page, "s1").click();
    await openLoopOptions(page);
    const startBefore = await field(page, "start").inputValue();

    await page.keyboard.press("i");
    await expect(field(page, "start")).toHaveValue(startBefore);

    await page.keyboard.press("l");
    await expect(loopButton(page)).toHaveClass(/active/);
    await page.keyboard.press("i");
    await openLoopOptions(page);
    await expect(field(page, "start")).toHaveValue("01.000");
    await page.keyboard.press("o");
    await expect(field(page, "end")).toHaveValue("01.500");
  });
});
