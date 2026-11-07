// Ctrl+K and ⌘K reach the library search; plain K stays the click track.

import { test, expect } from "@playwright/test";
import { openStudio, waitForClickTrack } from "./helpers.mjs";

const search = (page) => page.locator("#catalogSearch");
const clickToggle = (page) => page.locator("#t-metro");
const blurFocus = (page) => page.evaluate(() => document.activeElement?.blur());

async function openTrackView(page) {
  await openStudio(page, { tauri: true });
  await waitForClickTrack(page, { revealOptions: false });
  await blurFocus(page);
  await expect(search(page)).not.toBeFocused();
}

test.describe("library search shortcut", () => {
  test("Ctrl+K focuses the search from the track view without toggling the click", async ({ page }) => {
    await openTrackView(page);

    await page.keyboard.press("Control+K");
    await expect(search(page)).toBeFocused();
    await expect(clickToggle(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("⌘K focuses the search and selects what is already typed", async ({ page }) => {
    await openTrackView(page);
    await search(page).fill("Fixture");
    await blurFocus(page);

    await page.keyboard.press("Meta+K");
    await expect(search(page)).toBeFocused();
    const selected = await search(page).evaluate((el) => el.value.slice(el.selectionStart, el.selectionEnd));
    expect(selected).toBe("Fixture");
  });

  test("Ctrl+K opens a collapsed library first", async ({ page }) => {
    await openTrackView(page);
    await page.locator("#sidebarCollapseBtn").click();
    await expect(page.locator(".app")).toHaveClass(/cat-collapsed/);

    await page.keyboard.press("Control+K");
    await expect(page.locator(".app")).not.toHaveClass(/cat-collapsed/);
    await expect(search(page)).toBeFocused();
  });

  test("Ctrl+K works while another input has focus", async ({ page }) => {
    await openTrackView(page);
    await page.locator("#t-loop-start").focus();

    await page.keyboard.press("Control+K");
    await expect(search(page)).toBeFocused();
  });

  test("plain K still toggles the click", async ({ page }) => {
    await openTrackView(page);

    await page.keyboard.press("k");
    await expect(clickToggle(page)).toHaveAttribute("aria-pressed", "true");
    await expect(search(page)).not.toBeFocused();
  });

  test("the ⌘K hint hides while the search has text", async ({ page }) => {
    await openTrackView(page);
    const hint = page.locator(".search-kbd");
    await expect(hint).toBeVisible();

    await search(page).fill("zzz");
    await expect(hint).toBeHidden();

    await search(page).fill("");
    await expect(hint).toBeVisible();
  });
});
