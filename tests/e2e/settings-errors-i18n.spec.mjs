import { test, expect } from "@playwright/test";
import { seedLibrary, uiText } from "./helpers.mjs";

const LANGUAGE = "de";
const STEMS_LOCATION_URL = "**/api/settings/stems-location";
const RESET_URL = "**/api/reset";
const PICKED_FOLDER = "/scratch/new-stems";
const ENGLISH_DETAIL = "English text from the server";
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_UNPROCESSABLE = 422;
const HTTP_SERVER_ERROR = 500;
const JOB_BUSY = { code: "job_busy" };
const STEMS_LOCATION = { path: "/scratch/stems", bytes: 0, editable: true, restart_required: false, busy: false };

async function openSettings(page) {
  await page.addInitScript(
    (lang) => localStorage.setItem("stemdeck.language", JSON.stringify(lang)),
    LANGUAGE,
  );
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await expect(page.locator(".library-editor")).toBeVisible();
}

function fulfillJson(route, status, body) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function refuseStemsMove(page, status, extra) {
  await page.route(STEMS_LOCATION_URL, (route) => {
    if (route.request().method() === "GET") return fulfillJson(route, HTTP_OK, STEMS_LOCATION);
    return fulfillJson(route, status, { detail: ENGLISH_DETAIL, ...extra });
  });
  page.on("dialog", (dialog) => dialog.accept(PICKED_FOLDER));
}

async function expectTranslated(msg, page, key) {
  await expect(msg).toHaveText(await uiText(page, key));
  await expect(msg).not.toContainText(ENGLISH_DETAIL);
}

const MOVE_REFUSALS = [
  { name: "imports still queued", status: HTTP_CONFLICT, extra: {}, key: "settings.stemsLocation.queueBusy" },
  { name: "a song still being separated", status: HTTP_CONFLICT, extra: JOB_BUSY, key: "settings.jobBusy" },
  {
    name: "a folder that can't be used",
    status: HTTP_UNPROCESSABLE,
    extra: {},
    key: "settings.stemsLocation.unusable",
  },
  { name: "a move that fails", status: HTTP_SERVER_ERROR, extra: {}, key: "settings.stemsLocation.moveFailed" },
];

test.describe("Settings refusals in the user's language", () => {
  for (const { name, status, extra, key } of MOVE_REFUSALS) {
    test(`stems folder move refused: ${name}`, async ({ page }) => {
      await refuseStemsMove(page, status, extra);
      await openSettings(page);
      await page.locator(".set-stems-location").click();
      const msg = page.locator(".stems-location-msg");
      await expectTranslated(msg, page, key);
      await expect(msg).toHaveClass(/\berror\b/);
    });
  }

  for (const extra of [{}, JOB_BUSY]) {
    test(`reset refused while a song is processed ${JSON.stringify(extra)}`, async ({ page }) => {
      await page.route(
        RESET_URL,
        (route) => fulfillJson(route, HTTP_CONFLICT, { detail: ENGLISH_DETAIL, ...extra }),
      );
      await openSettings(page);
      await page.locator(".settings-reset-btn").click();
      await page.locator(".reset-confirm-input").fill("RESET");
      await page.locator(".reset-confirm-go").click();
      await expectTranslated(page.locator(".reset-confirm-msg"), page, "settings.jobBusy");
    });
  }
});
