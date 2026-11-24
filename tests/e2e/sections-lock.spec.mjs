// A locked section is pinned against editing: it cannot be dragged, resized or
// renamed, and a red padlock shows on it so a locked one is obvious at rest.
// Lock position lives in Edit section, which a double-click opens.
import { test, expect } from "@playwright/test";
import { openStudio, sectionEditDialog, JOB_ID } from "./helpers.mjs";

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

const LOCKED = { id: "s1", name: "Verse", start: 1, end: 3, color: "#4a7fff", locked: true };
const UNLOCKED = { id: "s1", name: "Verse", start: 1, end: 3, color: "#4a7fff" };

/** Drag from the middle of the block by dx pixels. */
async function dragBy(page, dx) {
  const box = await page.locator('.section-block[data-id="s1"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

async function toggleLockInEditor(page) {
  await page.locator('.section-block[data-id="s1"]').dblclick();
  await page.locator("#sectionEditLock").click();
  await page.locator("#sectionEditSave").click();
  await expect(sectionEditDialog(page)).toBeHidden();
}

test.describe("locking a section", () => {
  test("the padlock is red, and visible without hovering", async ({ page }) => {
    await seed(page, [LOCKED]);
    await openStudio(page);

    const lock = page.locator('.section-block[data-id="s1"] .section-lock-mark');
    await expect(lock).toBeVisible();

    const { locked, danger } = await page.evaluate(() => ({
      locked: getComputedStyle(document.querySelector(".section-block.sec-locked .section-lock-mark")).color,
      danger: getComputedStyle(document.documentElement).getPropertyValue("--danger").trim(),
    }));
    expect(danger, "--danger must be defined for this to mean anything").not.toBe("");
    // Same colour the rest of the app uses to say no, not a second red.
    const asRgb = await page.evaluate((c) => {
      const probe = document.createElement("span");
      probe.style.color = c;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    }, danger);
    expect(locked).toBe(asRgb);
  });

  test("an unlocked section is not red", async ({ page }) => {
    await seed(page, [UNLOCKED]);
    await openStudio(page);

    await expect(page.locator('.section-block[data-id="s1"]')).not.toHaveClass(/sec-locked/);
    await expect(page.locator('.section-block[data-id="s1"] .section-lock-mark')).toHaveCount(0);
  });

  test("a locked section refuses to be dragged", async ({ page }) => {
    await seed(page, [LOCKED]);
    await openStudio(page);

    await dragBy(page, 80);

    const [section] = await savedSections(page);
    expect(section.start).toBeCloseTo(1, 2);
    expect(section.end).toBeCloseTo(3, 2);
  });

  test("an unlocked section still drags, or the test above proves nothing", async ({ page }) => {
    await seed(page, [UNLOCKED]);
    await openStudio(page);

    await dragBy(page, 80);

    await expect.poll(async () => (await savedSections(page))[0]?.start > 1.05).toBe(true);
  });

  test("a locked section refuses to be resized", async ({ page }) => {
    await seed(page, [LOCKED]);
    await openStudio(page);

    const handle = page.locator('.section-block[data-id="s1"] .section-handle-r');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const [section] = await savedSections(page);
    expect(section.end).toBeCloseTo(3, 2);
  });

  test("the lock survives a reload", async ({ page }) => {
    await seed(page, [UNLOCKED]);
    await openStudio(page);

    await toggleLockInEditor(page);
    await expect(page.locator('.section-block[data-id="s1"]')).toHaveClass(/sec-locked/);
    await expect.poll(async () => (await savedSections(page))[0]?.locked).toBe(true);

    // The half that was silently broken before `locked` was declared on
    // SectionItem: it saved, answered 200, and came back false.
    await page.reload();
    await openStudio(page);
    await expect(page.locator('.section-block[data-id="s1"]')).toHaveClass(/sec-locked/);
  });

  test("Lock position again unlocks it", async ({ page }) => {
    await seed(page, [LOCKED]);
    await openStudio(page);

    await toggleLockInEditor(page);

    await expect(page.locator('.section-block[data-id="s1"]')).not.toHaveClass(/sec-locked/);
    await expect.poll(async () => (await savedSections(page))[0]?.locked).toBe(false);
  });
});
