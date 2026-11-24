// A setting the server did not keep, and a library the device could not save,
// both say so.

import { test, expect } from "@playwright/test";

import { failureMessages, seedLibrary, stubUpdateCheck, uiText, JOB_ID } from "./helpers.mjs";

const LIBRARY_KEY = "stemdeck.folders";


async function openGeneralSettings(page) {
  await seedLibrary(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await page.locator('.settings-tab[data-tab="general"]').click();
  await expect(page.locator(".set-playlist-max")).not.toHaveValue("");
}

async function refuseSettingsSave(page, refuse) {
  await page.route("**/api/settings", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    return refuse(route);
  });
}

test.describe("a setting the server did not save", () => {
  for (const [name, refuse] of [
    ["an error response", (route) => route.fulfill({ status: 500, json: { detail: "boom" } })],
    ["a network error", (route) => route.abort()],
  ]) {
    test(`goes back to the saved value and says so, on ${name}`, async ({ page }) => {
      await openGeneralSettings(page);
      const field = page.locator(".set-playlist-max");
      const saved = await field.inputValue();
      await refuseSettingsSave(page, refuse);

      await field.fill(String(Number(saved) + 7));
      await field.blur();

      await expect(field).toHaveValue(saved);
      await expect.poll(() => failureMessages(page)).toEqual([await uiText(page, "notif.settingsSaveFailed")]);
    });
  }
});

test.describe("a library the device could not save", () => {
  test("says so once, and again only after a save has worked", async ({ page }) => {
    await page.addInitScript((key) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function failingSetItem(k, v) {
        if (k === key && window.__e2eStoreFull) throw new DOMException("full", "QuotaExceededError");
        return setItem.call(this, k, v);
      };
    }, LIBRARY_KEY);
    await seedLibrary(page);
    await stubUpdateCheck(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const heart = page.locator(`#catalogList .cat-item[data-id="${JOB_ID}"] .cat-fav`).first();
    await expect(heart).toBeAttached();
    const toggleHeart = async () => {
      const pressed = await heart.getAttribute("aria-pressed");
      await heart.click({ force: true });
      await expect(heart).not.toHaveAttribute("aria-pressed", pressed);
    };
    const clearFailures = () => page.evaluate(() => document.getElementById("notifClearAll").click());

    await page.evaluate(() => { window.__e2eStoreFull = true; });
    await toggleHeart();
    await expect.poll(() => failureMessages(page)).toEqual([await uiText(page, "notif.storageFull")]);

    await clearFailures();
    await toggleHeart();
    await page.waitForTimeout(300);
    expect(await failureMessages(page)).toEqual([]);

    await page.evaluate(() => { window.__e2eStoreFull = false; });
    await toggleHeart();
    await page.evaluate(() => { window.__e2eStoreFull = true; });
    await toggleHeart();
    await expect.poll(() => failureMessages(page)).toEqual([await uiText(page, "notif.storageFull")]);
  });
});
