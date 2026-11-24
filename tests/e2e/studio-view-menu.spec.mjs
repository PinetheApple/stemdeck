// The Sections and View buttons over the lanes. Sections holds Add section,
// Clear and Hide the sections bar; View holds Auto-scroll, Sections bar and
// Beat grid, each a toggle that shows its state.
import { test, expect } from "@playwright/test";
import { openStudio, openSectionsMenu, openViewMenu, JOB_ID, TALL_WINDOW } from "./helpers.mjs";

const VERSE = { id: "s1", name: "Verse", start: 1, end: 3, color: "#4a7fff" };

test.use({ viewport: TALL_WINDOW });

test.afterEach(async ({ page }) => {
  await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections: [] } });
});

async function seed(page, sections) {
  const res = await page.request.patch(`/api/jobs/${JOB_ID}/sections`, { data: { sections } });
  expect(res.ok(), "seeding sections").toBe(true);
}

const app = (page) => page.locator(".app");

async function expectInsideWindow(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const { width, height } = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
}

test.describe("Sections menu", () => {
  test("holds Add section, and Clear only once there is something to clear", async ({ page }) => {
    await openStudio(page);
    await openSectionsMenu(page);

    await expect(page.locator("#sectionsAddBtn")).toBeVisible();
    await expect(page.locator("#sectionsAddBtn")).toHaveText(/Add section/);
    await expect(page.locator("#sectionsClearBtn")).toBeHidden();
    await expectInsideWindow(page, "#sectionsPanel");
  });

  test("Clear asks for a second click, then clears", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);
    await openSectionsMenu(page);

    const clear = page.locator("#sectionsClearBtn");
    await clear.click();
    await expect(clear).toHaveText(/Confirm\?/);
    await expect(page.locator(".section-block")).toHaveCount(1);
    await clear.click();

    await expect(page.locator(".section-block")).toHaveCount(0);
  });

  test("Hide the sections bar hides it, and Show the sections bar brings it back", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);
    await openSectionsMenu(page);

    await page.locator("#sectionsHideBtn").click();
    await expect(app(page)).toHaveClass(/panel-sections-off/);
    const show = page.locator("#sectionsShowBtn");
    await expect(show).toBeVisible();
    await expect(show).toBeFocused();
    await expect(page.locator("#sectionsHideBtn")).toBeHidden();

    await show.click();
    await expect(app(page)).not.toHaveClass(/panel-sections-off/);
    await expect(page.locator(".section-block")).toBeVisible();
  });
});

test.describe("View menu", () => {
  test("lists Auto-scroll, Sections bar and Beat grid, each showing its state", async ({ page }) => {
    await openStudio(page);
    await openViewMenu(page);

    for (const id of ["#autoScrollBtn", "#viewSectionsBtn", "#beatGridViewBtn"]) {
      await expect(page.locator(`#viewPanel ${id}`)).toHaveAttribute("aria-pressed", "true");
    }
    await expectInsideWindow(page, "#viewPanel");
  });

  test("Sections bar hides and shows the bar", async ({ page }) => {
    await seed(page, [VERSE]);
    await openStudio(page);
    await openViewMenu(page);

    const toggle = page.locator("#viewSectionsBtn");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(app(page)).toHaveClass(/panel-sections-off/);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".section-block")).toBeVisible();
  });

  test("Auto-scroll turns off and stays off after a reload", async ({ page }) => {
    await openStudio(page);
    await openViewMenu(page);

    await page.locator("#autoScrollBtn").click();
    await expect(page.locator("#autoScrollBtn")).toHaveAttribute("aria-pressed", "false");
    await page.reload();
    await openStudio(page);
    await expect(page.locator("#autoScrollBtn")).toHaveAttribute("aria-pressed", "false");
    await openViewMenu(page);
    await page.locator("#autoScrollBtn").click();
  });

  test("Beat grid off keeps the grid lines hidden while the click plays", async ({ page }) => {
    await openStudio(page);
    const grid = page.locator("#beatgrid-canvas");
    await expect(page.locator("#t-click")).toBeEnabled();
    await page.locator("body").press("k");
    await expect(grid).toBeVisible();

    await openViewMenu(page);
    await page.locator("#beatGridViewBtn").click();
    await expect(page.locator("#beatGridViewBtn")).toHaveAttribute("aria-pressed", "false");
    await expect(grid).toBeHidden();

    await page.locator("#beatGridViewBtn").click();
    await expect(grid).toBeVisible();
  });

  test("the song head no longer carries Collapse or Auto-scroll", async ({ page }) => {
    await openStudio(page);

    await expect(page.locator("#songHead .daw-panel-toggles")).toHaveCount(0);
    await expect(page.locator("#songHead #autoScrollBtn")).toHaveCount(0);
  });
});
