// Settings > Appearance: a theme, a font and the cover colour wash, each applied
// at once and remembered on this device.

import { test, expect } from "@playwright/test";
import { JOB_ID, fixtureTrack, openStudio, seedLibrary, settleRoutes, stubUpdateCheck } from "./helpers.mjs";
import { openSettings } from "./settingsHelpers.mjs";

test.afterEach(settleRoutes);

// A 1x1 PNG. data: is in the page's img-src, so it loads with no network.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const THEME_ACCENT = { "ink-coral": "#ff6f59", "ink-ice": "#eef1f4", "dusk-coral": "#ff7d68" };
const DUSK_BG = "#131018";
const FONT_FILE = "/fonts/inter-latin-wght-normal.woff2";

async function openApp(page) {
  await seedLibrary(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
}

const rootToken = (page, name) =>
  page.evaluate((prop) => getComputedStyle(document.documentElement).getPropertyValue(prop).trim(), name);
const themeCard = (page, id) => page.locator(`.appearance-theme[data-theme-choice="${id}"]`);
const fontCard = (page, id) => page.locator(`.appearance-font[data-font-choice="${id}"]`);

test("a theme applies at once, shows as chosen and survives a reload", async ({ page }) => {
  await openApp(page);
  await openSettings(page, "appearance");
  await expect(page.locator(".appearance-theme")).toHaveText(["Ink & coral", "Ink & ice", "Dusk & coral"]);
  await expect(themeCard(page, "ink-coral")).toHaveAttribute("aria-pressed", "true");
  expect(await rootToken(page, "--accent")).toBe(THEME_ACCENT["ink-coral"]);

  await themeCard(page, "ink-ice").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "ink-ice");
  await expect(themeCard(page, "ink-ice")).toHaveAttribute("aria-pressed", "true");
  await expect(themeCard(page, "ink-coral")).toHaveAttribute("aria-pressed", "false");
  expect(await rootToken(page, "--accent")).toBe(THEME_ACCENT["ink-ice"]);

  await themeCard(page, "dusk-coral").click();
  expect(await rootToken(page, "--bg")).toBe(DUSK_BG);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dusk-coral");
  expect(await rootToken(page, "--accent")).toBe(THEME_ACCENT["dusk-coral"]);
});

test("a font applies at once from the app's own files and survives a reload", async ({ page }) => {
  // The card shows "Aa" in its own face, so the file loads with the pane.
  const fontLoad = page.waitForResponse((res) => res.url().endsWith(FONT_FILE) && res.ok());
  await openApp(page);
  await openSettings(page, "appearance");
  await fontLoad;
  await expect(page.locator(".appearance-font")).toHaveCount(7);
  await expect(fontCard(page, "manrope")).toHaveAttribute("aria-pressed", "true");

  await fontCard(page, "inter").click();
  await expect(page.locator("html")).toHaveAttribute("data-font", "inter");
  await expect(fontCard(page, "inter")).toHaveAttribute("aria-pressed", "true");
  const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(family.startsWith('"Inter"') || family.startsWith("Inter")).toBe(true);
  await expect.poll(() => page.evaluate(() => document.fonts.check('16px "Inter"'))).toBe(true);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-font", "inter");
});

test("the cover colour wash tints the studio with the cover, and turns off for good", async ({ page }) => {
  const catalog = {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: { [JOB_ID]: { ...fixtureTrack(JOB_ID, "With Cover"), thumb: PIXEL } },
  };
  await openStudio(page, { catalog });
  const wash = page.locator("#lanes > .cover-wash");
  await expect(wash).toBeVisible();
  expect(await wash.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("data:image/png");

  const pane = await openSettings(page, "appearance");
  const toggle = pane.locator(".appearance-wash");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).toHaveAttribute("data-wash", "off");
  await expect(wash).toBeHidden();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-wash", "off");
});
