// Ctrl+K and ⌘K open Browse library and focus its search; plain K stays the click track.

import { test, expect } from "@playwright/test";
import { openInspectorTab, openLoopOptions, openStudio, waitForClickTrack } from "./helpers.mjs";

const search = (page) => page.locator("#browseSearch");
const browse = (page) => page.locator("#browseLibrary");
const clickToggle = (page) => page.locator("#t-metro");
const blurFocus = (page) => page.evaluate(() => document.activeElement?.blur());
const app = (page) => page.locator(".app");

async function openTrackView(page) {
  await openStudio(page, { tauri: true });
  await waitForClickTrack(page, { revealOptions: false });
  await blurFocus(page);
  await expect(browse(page)).toBeHidden();
}

test.describe("library search shortcut", () => {
  test("Ctrl+K opens Browse library and focuses its search without toggling the click", async ({ page }) => {
    await openTrackView(page);

    await page.keyboard.press("Control+K");
    await expect(browse(page)).toBeVisible();
    await expect(search(page)).toBeFocused();
    await expect(clickToggle(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("⌘K focuses the search and selects what is already typed", async ({ page }) => {
    await openTrackView(page);
    await page.keyboard.press("Meta+K");
    await search(page).fill("Fixture");
    await page.locator("#browseListBtn").focus();

    await page.keyboard.press("Meta+K");
    await expect(search(page)).toBeFocused();
    const selected = await search(page).evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selected).toBe("Fixture");
  });

  test("Ctrl+K works from a collapsed sidebar", async ({ page }) => {
    await openTrackView(page);
    await page.locator("#sidebarCollapseBtn").click();
    await expect(app(page)).toHaveClass(/cat-collapsed/);

    await page.keyboard.press("Control+K");
    await expect(search(page)).toBeFocused();
  });

  test("Ctrl+K works while another input has focus", async ({ page }) => {
    await openTrackView(page);
    await openLoopOptions(page);
    await page.locator("#t-loop-start").focus();

    await page.keyboard.press("Control+K");
    await expect(search(page)).toBeFocused();
  });

  test("plain K still toggles the click", async ({ page }) => {
    await openTrackView(page);

    await page.keyboard.press("k");
    await expect(clickToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(browse(page)).toBeHidden();
  });

  test("Ctrl+K does nothing while a dialog is open", async ({ page }) => {
    await openTrackView(page);
    await page.locator("#aboutBtn").click();
    await expect(page.locator(".library-editor")).toBeVisible();

    await page.keyboard.press("Control+K");
    await expect(browse(page)).toBeHidden();
  });

  test("Ctrl+K opens Browse library over the Lyrics tab, which is still open after Esc", async ({ page }) => {
    await openTrackView(page);
    await openInspectorTab(page, "lyrics");
    await blurFocus(page);

    await page.keyboard.press("Control+K");
    await expect(search(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(browse(page)).toBeHidden();
    await expect(page.locator("#lyricsPanel")).toBeVisible();
  });

  test("Ctrl+K does nothing in Stage mode", async ({ page }) => {
    await openTrackView(page);
    await page.locator("#stageModeBtn").click();
    await expect(app(page)).toHaveClass(/stage-mode/);
    await blurFocus(page);

    await page.keyboard.press("Control+K");
    await expect(browse(page)).toBeHidden();
    await expect(app(page)).toHaveClass(/stage-mode/);
  });
});
