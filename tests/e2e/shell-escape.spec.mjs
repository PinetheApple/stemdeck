// One Esc order for the whole shell (#233): error box, menu or popover, dialog,
// Guide, Stage mode. Dialogs dim the page, popovers stay in the window, and
// Guide explains the shell and leaves no tooltip behind.

import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

const SHORT_WINDOW = { width: 1024, height: 240 };
const EDGE_PX = 8;
const MIN_SCRIM_ALPHA = 0.4;
const GUIDE_CONTROLS = [
  "#sidebarCollapseBtn", ".topbar-brand", "#addSongBtn", "#notifBtn", "#helpModeBtn", "#aboutBtn",
  "#settingsBtn", "#inspectorToggleBtn", "#libraryResizer", "#stemsResizer", "#inspectorResizer",
  ".lib-nav-library", ".lib-nav-favorites", ".lib-nav-trash", "#songToolsLyricsBtn",
];

const guideOn = (page) => page.locator("body").evaluate((el) => el.classList.contains("help-mode"));
const stageOn = (page) => page.locator(".app").evaluate((el) => el.classList.contains("stage-mode"));
const settingsDialog = (page) => page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator(".settings-reset-btn, .library-editor-body") });

/** Pressed straight on the button: a scrim over it would take a real click. */
const pressGuide = (page) => page.locator("#helpModeBtn").dispatchEvent("click");

function alphaOf(color) {
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return parts.length === 4 ? parts[3] : parts.length === 3 ? 1 : 0;
}

test.describe("Esc closes the topmost thing only", () => {
  test("Guide before Stage mode", async ({ page }) => {
    await openStudio(page);
    await page.locator("#helpModeBtn").click();
    await page.keyboard.press("f");
    expect(await stageOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await guideOn(page)).toBe(false);
    expect(await stageOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await stageOn(page)).toBe(false);
  });

  test("a dialog before Guide", async ({ page }) => {
    await openStudio(page);
    await page.locator("#settingsBtn").click();
    await expect(settingsDialog(page)).toBeVisible();
    await pressGuide(page);
    expect(await guideOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(settingsDialog(page)).toHaveCount(0);
    expect(await guideOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await guideOn(page)).toBe(false);
  });

  test("a popover before Guide, and Alerts closes on Esc", async ({ page }) => {
    await openStudio(page);
    await page.locator("#notifBtn").click();
    await expect(page.locator(".daw-notif-panel")).toBeVisible();
    // Not a click: any click outside Alerts closes it.
    await page.evaluate(async () => (await import("/js/helpMode.js")).setHelpMode(true));
    expect(await guideOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".daw-notif-panel")).toBeHidden();
    expect(await guideOn(page)).toBe(true);
  });
});

test.describe("dialogs and popovers", () => {
  test("Settings and About dim the page with the one scrim", async ({ page }) => {
    await openStudio(page);
    for (const [opener, dialog] of [["#settingsBtn", settingsDialog(page)], ["#aboutBtn", page.locator("#aboutDialog")]]) {
      await page.locator(opener).click();
      await expect(dialog).toBeVisible();
      const { backdrop, scrim } = await dialog.evaluate((el) => ({
        backdrop: getComputedStyle(el.closest(".about-backdrop, .library-editor-backdrop")).backgroundColor,
        scrim: getComputedStyle(document.documentElement).getPropertyValue("--scrim").trim(),
      }));
      expect(backdrop, opener).toBe(scrim);
      expect(alphaOf(backdrop), opener).toBeGreaterThanOrEqual(MIN_SCRIM_ALPHA);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  });

  test("Alerts stays inside a short window and scrolls inside itself", async ({ page }) => {
    await openStudio(page, { updateAvailable: true });
    await page.setViewportSize(SHORT_WINDOW);
    await page.locator("#notifBtn").click();
    const panel = page.locator(".daw-notif-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(EDGE_PX - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(SHORT_WINDOW.height - EDGE_PX + 1);
    expect(box.x + box.width).toBeLessThanOrEqual(SHORT_WINDOW.width);
    const overflowY = await panel.evaluate((el) => getComputedStyle(el).overflowY);
    expect(["auto", "scroll"]).toContain(overflowY);
  });
});

test.describe("Guide and the shell", () => {
  test("explains every control of the shell", async ({ page }) => {
    await openStudio(page);
    await page.locator("#helpModeBtn").click();
    for (const selector of GUIDE_CONTROLS) {
      await page.locator(selector).first().hover({ force: true });
      await expect(page.locator("#helpTip"), selector).toBeVisible();
      await expect(page.locator("#helpTip"), selector).not.toBeEmpty();
    }
  });

  test("leaving by the button or by Esc removes the tooltip", async ({ page }) => {
    await openStudio(page);
    const tip = page.locator("#helpTip");
    await page.locator("#helpModeBtn").click();
    await page.locator("#settingsBtn").hover();
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    await page.locator("#helpModeBtn").click();
    await page.locator("#helpModeBtn").hover();
    await page.locator("#helpModeBtn").click();
    await expect(tip).toBeHidden();
    await page.mouse.move(1, 1);
    await page.locator("#settingsBtn").hover();
    await expect(tip).toBeHidden();
  });
});
