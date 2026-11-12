// The server words its Settings refusals in English; the dialog shows them in
// the user's language, picked by status and code, never by the server's text.

import { test, expect } from "@playwright/test";
import { seedLibrary, uiText } from "./helpers.mjs";

const LANGUAGE = "de";
const STEMS_LOCATION_URL = "**/api/settings/stems-location";
const PICKED_FOLDER = "/scratch/new-stems";
const ENGLISH_DETAIL = "English text from the server";

async function openSettings(page) {
  await page.addInitScript((lang) => localStorage.setItem("stemdeck.language", JSON.stringify(lang)), LANGUAGE);
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await expect(page.locator(".library-editor")).toBeVisible();
}

async function refuseStemsMove(page, status, extra = {}) {
  await page.route(STEMS_LOCATION_URL, (route) => {
    const body = route.request().method() === "GET"
      ? { path: "/scratch/stems", bytes: 0, editable: true, restart_required: false, busy: false }
      : { detail: ENGLISH_DETAIL, ...extra };
    return route.fulfill({
      status: route.request().method() === "GET" ? 200 : status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
  page.on("dialog", (dialog) => dialog.accept(PICKED_FOLDER));
}

async function moveStems(page) {
  await page.locator(".set-stems-location").click();
  return page.locator(".stems-location-msg");
}

const MOVE_REFUSALS = [
  { name: "imports still queued", status: 409, extra: {}, key: "settings.stemsLocation.queueBusy" },
  { name: "a song still being separated", status: 409, extra: { code: "job_busy" }, key: "settings.jobBusy" },
  { name: "a folder that can't be used", status: 422, extra: {}, key: "settings.stemsLocation.unusable" },
  { name: "a move that fails", status: 500, extra: {}, key: "settings.stemsLocation.moveFailed" },
];

test.describe("Settings refusals in the user's language", () => {
  for (const { name, status, extra, key } of MOVE_REFUSALS) {
    test(`stems folder move refused: ${name}`, async ({ page }) => {
      await refuseStemsMove(page, status, extra);
      await openSettings(page);
      const msg = await moveStems(page);
      await expect(msg).toHaveText(await uiText(page, key));
      await expect(msg).toHaveClass(/\berror\b/);
    });
  }

  for (const extra of [{}, { code: "job_busy" }]) {
    test(`reset refused while a song is processed ${JSON.stringify(extra)}`, async ({ page }) => {
      await page.route("**/api/reset", (route) =>
        route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ detail: ENGLISH_DETAIL, ...extra }) }),
      );
      await openSettings(page);
      await page.locator(".settings-reset-btn").click();
      await page.locator(".reset-confirm-input").fill("RESET");
      await page.locator(".reset-confirm-go").click();
      await expect(page.locator(".reset-confirm-msg")).toHaveText(await uiText(page, "settings.jobBusy"));
    });
  }
});
