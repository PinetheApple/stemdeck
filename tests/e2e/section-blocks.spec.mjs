// Section blocks over the lanes: a click goes to the section, the loop button
// loops it, and a double-click opens Edit section (rename, lock, delete).
import { test, expect } from "@playwright/test";
import { openStudio, openLoopOptions, sectionEditDialog, addSection, JOB_ID, TALL_WINDOW } from "./helpers.mjs";

const VERSE = { id: "s1", name: "Verse", start: 1, end: 3, color: "#4a7fff" };
const CHORUS = { id: "s2", name: "Chorus", start: 3, end: 5, color: "#2ab8e8" };
const LOCKED_VERSE = { ...VERSE, locked: true };

test.use({ viewport: TALL_WINDOW });

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function seed(page, sections) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "seeding sections").toBe(true);
}

const savedSections = async (page) => {
  const res = await page.request.get(`/api/jobs/${JOB_ID}`);
  return (await res.json()).sections ?? [];
};

const block = (page, id) => page.locator(`.section-block[data-id="${id}"]`);
const loopButton = (page, id) => block(page, id).locator(".section-loop");
const loopIsOn = (page) => page.locator("#t-loop").evaluate((el) => el.classList.contains("active"));

async function loopBounds(page) {
  await openLoopOptions(page);
  return [await page.locator("#t-loop-start").inputValue(), await page.locator("#t-loop-end").inputValue()];
}

async function pressLoopButton(page, id) {
  await block(page, id).hover();
  await loopButton(page, id).click();
}

test.describe("section blocks", () => {
  test("a block shows its name and start time, as wide as its share of the song", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);

    await expect(block(page, "s1").locator(".section-label")).toHaveText("Verse");
    await expect(block(page, "s1").locator(".section-time")).toHaveText("00:01");
    const share = await page.evaluate(() => {
      const el = document.querySelector('.section-block[data-id="s1"]');
      return el.getBoundingClientRect().width / document.getElementById("daw-sections-track").getBoundingClientRect().width;
    });
    expect(share).toBeCloseTo(2 / 6, 2);
  });

  test("a click moves the playhead to the section's start and leaves Loop off", async ({ page }) => {
    await seed(page, [VERSE, CHORUS]);
    await openStudio(page);

    await block(page, "s2").click();

    await expect(page.locator("#footer-time-elapsed")).toHaveText("00:03");
    expect(await loopIsOn(page)).toBe(false);
  });

  test("the section under the playhead is shaded in the bar and down the lanes", async ({ page }) => {
    await seed(page, [VERSE, CHORUS]);
    await openStudio(page);

    await block(page, "s2").click();

    await expect(block(page, "s2")).toHaveClass(/is-current/);
    await expect(block(page, "s1")).not.toHaveClass(/is-current/);
    const columns = page.locator("#sectionCols .section-col");
    await expect(columns).toHaveCount(2);
    await expect(columns.nth(1)).toHaveClass(/is-current/);
    await expect(columns.nth(0)).not.toHaveClass(/is-current/);
  });

  test("the loop button shows on hover and loops the section", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);

    await expect(loopButton(page, "s1")).toBeHidden();
    await pressLoopButton(page, "s1");

    expect(await loopIsOn(page)).toBe(true);
    expect(await loopBounds(page)).toEqual(["01.000", "03.000"]);
    await page.mouse.move(0, 0);
    await expect(block(page, "s1")).toHaveClass(/is-looped/);
    await expect(loopButton(page, "s1")).toBeVisible();
    await expect(loopButton(page, "s1")).toHaveAttribute("aria-pressed", "true");
    await expect(loopButton(page, "s1")).toHaveAttribute("aria-label", "Loop Verse");
  });

  test("pressed again while its section loops, the loop button turns Loop off", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);

    await pressLoopButton(page, "s1");
    await pressLoopButton(page, "s1");

    expect(await loopIsOn(page)).toBe(false);
    await expect(block(page, "s1")).not.toHaveClass(/is-looped/);
  });

  test("a locked section still goes there and loops", async ({ page }) => {
    await seed(page, [LOCKED_VERSE, CHORUS]);
    await openStudio(page);

    await block(page, "s2").click();
    await block(page, "s1").click();
    await expect(page.locator("#footer-time-elapsed")).toHaveText("00:01");
    await pressLoopButton(page, "s1");
    expect(await loopIsOn(page)).toBe(true);
  });

  test("a drag moves the section without seeking or looping", async ({ page }) => {
    await seed(page, [{ ...VERSE, end: 2 }]);
    await openStudio(page);

    const box = await block(page, "s1").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect.poll(async () => (await savedSections(page))[0]?.start > 1.05).toBe(true);
    await expect(page.locator("#footer-time-elapsed")).toHaveText("00:00");
    expect(await loopIsOn(page)).toBe(false);
  });
});

test.describe("Edit section", () => {
  test("Lock position locks at once and keeps the name from being edited", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);

    await block(page, "s1").dblclick();
    const lock = page.locator("#sectionEditLock");
    await expect(lock).toHaveAttribute("aria-pressed", "false");
    await lock.click();

    await expect(lock).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#sectionEditName")).toBeDisabled();
    await expect.poll(async () => (await savedSections(page))[0]?.locked).toBe(true);
    await page.keyboard.press("Escape");
    await expect(block(page, "s1")).toHaveClass(/sec-locked/);
  });

  test("Delete section removes it", async ({ page }) => {
    await seed(page, [VERSE, CHORUS]);
    await openStudio(page);

    await block(page, "s1").dblclick();
    await page.locator("#sectionEditDelete").click();

    await expect(sectionEditDialog(page)).toBeHidden();
    await expect(page.locator(".section-block")).toHaveCount(1);
    await expect.poll(async () => (await savedSections(page)).map((s) => s.id)).toEqual(["s2"]);
  });

  test("Add section opens Edit section on the new one", async ({ page }) => {
    await openStudio(page);

    await addSection(page);

    await expect(page.locator(".section-block")).toHaveCount(1);
    await expect.poll(async () => (await savedSections(page)).length).toBe(1);
  });
});
