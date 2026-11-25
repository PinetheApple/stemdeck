// The logo is the app's name in the top bar, not a link to another site.
import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

test.describe("the top-bar logo", () => {
  test("shows the name and is not a link", async ({ page }) => {
    await openStudio(page, { tauri: true });

    const brand = page.locator(".topbar-brand");
    await expect(brand).toBeVisible();
    await expect(brand).toHaveText("StemDeck");
    await expect(page.locator("#topbar a")).toHaveCount(0);
    await expect(brand).not.toHaveAttribute("title", /./);
    await expect(brand).not.toHaveAttribute("aria-label", /./);
  });

  test("Guide has nothing to say about it", async ({ page }) => {
    await openStudio(page);
    await page.locator("#helpModeBtn").click();
    await page.locator(".topbar-brand").hover();
    await expect(page.locator("#helpTip")).toBeHidden();
  });

  test("the logo sits centred in the top bar", async ({ page }) => {
    await openStudio(page, { tauri: true });

    const box = await page.evaluate(() => {
      const bar = document.querySelector("#topbar").getBoundingClientRect();
      const img = document.querySelector(".topbar-brand img").getBoundingClientRect();
      return { above: Math.round(img.top - bar.top), below: Math.round(bar.bottom - img.bottom) };
    });
    expect(Math.abs(box.above - box.below)).toBeLessThanOrEqual(1);
  });
});
