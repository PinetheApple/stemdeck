// The error box: the studio's one alert surface (#error, showError in
// job.js). It used to be a faint red strip across the top bar that could be
// neither read nor closed when a failure gave it no "Try again".

import { test, expect } from "@playwright/test";
import { openStudio, waitForPanesSettled } from "./helpers.mjs";

async function failAnExport(page) {
  await page.locator("#t-export-btn").click();
  await page.locator("#t-export-mix").click();
  await page.evaluate(() => window.__e2e.choosePath());
  await page.evaluate(() => window.__e2e.failSave("disk full"));
  await expect(page.locator("#error")).toBeVisible();
}

test.describe("the error box", () => {
  test("is a readable card that its close button dismisses", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await failAnExport(page);
    const box = page.locator("#error");
    await expect(box).toContainText("disk full");
    const look = await box.evaluate((el) => {
      const s = getComputedStyle(el);
      return { position: s.position, background: s.backgroundColor, color: s.color };
    });
    // In a desktop window it floats over the waveforms, off the import bar.
    expect(look.position).toBe("absolute");
    // Opaque, so the page behind never shows through the words.
    expect(look.background).toMatch(/^rgb\(/);
    // The body text token (--text), not a tint of the error colour.
    expect(look.color).toBe("rgb(245, 243, 241)");
    await box.getByRole("button", { name: "Dismiss" }).click();
    await expect(box).toBeHidden();
  });

  for (const width of [620, 900]) {
    test(`in a ${width} px window it sits above the song, covering no control`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openStudio(page);
      await waitForPanesSettled(page);
      await page.evaluate(async () => (await import("/js/job.js")).showError("Something failed."));
      const box = page.locator("#error");
      await expect(box).toBeVisible();
      expect(await box.evaluate((el) => getComputedStyle(el).position)).toBe("relative");
      const error = await box.boundingBox();
      const topbar = await page.locator(".daw-topbar").boundingBox();
      const songHead = await page.locator("#songHead").boundingBox();
      expect(error.y).toBeGreaterThanOrEqual(topbar.y + topbar.height);
      expect(error.y + error.height).toBeLessThanOrEqual(songHead.y);
    });
  }

  test("in stage mode it leaves Exit and the transport uncovered", async ({ page }) => {
    await openStudio(page);
    await page.locator("#stageModeBtn").click();
    await expect(page.locator("#stageExitBtn")).toBeVisible();
    await page.evaluate(async () => (await import("/js/job.js")).showError("Something failed."));
    const error = await page.locator("#error").boundingBox();
    const exit = await page.locator("#stageExitBtn").boundingBox();
    const transport = await page.locator(".stage-transport").boundingBox();
    expect(error.y).toBeGreaterThanOrEqual(exit.y + exit.height);
    expect(error.y + error.height).toBeLessThanOrEqual(transport.y);
  });

  test("the older retry: false still shows no Try again", async ({ page }) => {
    await openStudio(page);
    await page.evaluate(async () =>
      (await import("/js/job.js")).showError("Something failed.", null, { retry: false }),
    );
    const box = page.locator("#error");
    await expect(box).toBeVisible();
    await expect(box.locator(".retry-btn")).toHaveCount(0);
  });

  test("Escape closes it", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await failAnExport(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#error")).toBeHidden();
  });

  test("Escape closes it alone, leaving a popup beneath it open", async ({ page }) => {
    await openStudio(page, { tauri: true });
    await page.locator("#settingsBtn").click();
    await page.locator('.settings-tab[data-tab="details"]').click();
    const settings = page.locator(".set-acoustid-key");
    await expect(settings).toBeVisible();
    await page.evaluate(async () => (await import("/js/job.js")).showError("Something failed.", null, { onRetry: null }));
    await expect(page.locator("#error")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#error")).toBeHidden();
    await expect(settings).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
  });
});
