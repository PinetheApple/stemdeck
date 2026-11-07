// The About box's "Where your data goes" section: closed until asked for, and
// opening it keeps the box on screen at the smallest supported window.

import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

const SMALL_WINDOW = { width: 1024, height: 768 };
const DATA_LINES = 9;

async function openAbout(page) {
  await page.setViewportSize(SMALL_WINDOW);
  await openStudio(page);
  await page.locator("#aboutBtn").click();
  await expect(page.locator("#aboutDialog")).toBeVisible();
}

test("Where your data goes starts closed, opens to its list and closes again", async ({ page }) => {
  await openAbout(page);
  const section = page.locator("#aboutData");
  const summary = page.locator("#aboutDataSummary");
  const items = page.locator("#aboutDataList li");

  await expect(summary).toHaveText("Where your data goes");
  await expect(section).not.toHaveAttribute("open");
  await expect(items.first()).toBeHidden();

  await summary.click();
  await expect(section).toHaveAttribute("open", "");
  await expect(items).toHaveCount(DATA_LINES);
  for (const item of await items.all()) await expect(item).toBeVisible();
  await expect(items.first()).toHaveText(/your audio is never uploaded/);

  await summary.click();
  await expect(section).not.toHaveAttribute("open");
  await expect(items.first()).toBeHidden();
});

test("the open section keeps the About box inside a 1024 x 768 window", async ({ page }) => {
  await openAbout(page);
  await page.locator("#aboutDataSummary").click();
  const card = await page.locator("#aboutDialog .about-card").boundingBox();
  expect(card.y).toBeGreaterThanOrEqual(0);
  expect(card.y + card.height).toBeLessThanOrEqual(SMALL_WINDOW.height);

  const last = page.locator("#aboutDataList li").last();
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});
