// The stem format setting in Settings > General.
//
// WAV is the default, and the bitrate only means something for MP3, so it is
// dimmed and inert until MP3 is chosen. A choice has to reach the server, which
// reads it when each song finishes.

import { test, expect } from "@playwright/test";
import { seedLibrary } from "./helpers.mjs";

const DEFAULTS = { stem_format: "wav", stem_mp3_kbps: 128 };
const CHOSEN_KBPS = 192;
const SETTINGS_PATH = /^\/api\/settings$/;

const formatSelect = (page) => page.locator(".set-stem-format");
const kbpsSelect = (page) => page.locator(".set-stem-mp3-kbps");
const kbpsRow = (page) => page.locator(".settings-row:has(.set-stem-mp3-kbps)");

// Waits for every settings read the dialog starts, since a late answer would undo a choice made first.
async function openSettings(page) {
  const reads = [];
  const trackSettingsRead = function trackSettingsRead(request) {
    if (SETTINGS_PATH.test(new URL(request.url()).pathname) && request.method() === "GET") {
      reads.push(request.response());
    }
  };
  page.on("request", trackSettingsRead);
  await page.locator("#settingsBtn").click();
  await expect(formatSelect(page)).toBeVisible();
  await Promise.all(reads);
  page.off("request", trackSettingsRead);
}

async function serverSettings(page) {
  const settings = await (await page.request.get("/api/settings")).json();
  return { stem_format: settings.stem_format, stem_mp3_kbps: settings.stem_mp3_kbps };
}

test.describe("stem format", () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post("/api/settings", { data: DEFAULTS });
    await seedLibrary(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
  });

  // The backend is shared across the suite; leave it as every other spec expects.
  test.afterEach(async ({ page }) => {
    await page.request.post("/api/settings", { data: DEFAULTS });
  });

  test("defaults to WAV with the bitrate dimmed", async ({ page }) => {
    await openSettings(page);

    await expect(formatSelect(page)).toHaveValue("wav");
    await expect(kbpsRow(page)).toHaveClass(/disabled/);
    await expect(kbpsSelect(page)).toBeDisabled();
    await expect(kbpsSelect(page)).toHaveValue(String(DEFAULTS.stem_mp3_kbps));
  });

  test("choosing MP3 enables the bitrate and saves both", async ({ page }) => {
    await openSettings(page);

    await formatSelect(page).selectOption("mp3");
    await expect(kbpsRow(page)).not.toHaveClass(/disabled/);
    await expect(kbpsSelect(page)).toBeEnabled();
    await expect.poll(() => serverSettings(page)).toEqual({ ...DEFAULTS, stem_format: "mp3" });

    await kbpsSelect(page).selectOption(String(CHOSEN_KBPS));
    await expect.poll(() => serverSettings(page)).toEqual({ stem_format: "mp3", stem_mp3_kbps: CHOSEN_KBPS });
  });

  test("the choice survives a reload", async ({ page }) => {
    await openSettings(page);
    await formatSelect(page).selectOption("mp3");
    await kbpsSelect(page).selectOption(String(CHOSEN_KBPS));
    await expect.poll(() => serverSettings(page)).toEqual({ stem_format: "mp3", stem_mp3_kbps: CHOSEN_KBPS });

    await page.reload({ waitUntil: "domcontentloaded" });
    await openSettings(page);

    await expect(formatSelect(page)).toHaveValue("mp3");
    await expect(kbpsSelect(page)).toHaveValue(String(CHOSEN_KBPS));
    await expect(kbpsSelect(page)).toBeEnabled();
  });

  test("switching back to WAV dims the bitrate again", async ({ page }) => {
    await page.request.post("/api/settings", { data: { stem_format: "mp3" } });
    await openSettings(page);
    await expect(kbpsSelect(page)).toBeEnabled();

    await formatSelect(page).selectOption("wav");

    await expect(kbpsRow(page)).toHaveClass(/disabled/);
    await expect(kbpsSelect(page)).toBeDisabled();
    await expect.poll(async () => (await serverSettings(page)).stem_format).toBe("wav");
  });
});
