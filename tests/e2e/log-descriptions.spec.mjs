// Settings > Logs shows each file's description in the app language (#70).
//
// The server sends an English `description` plus a `description_key`. The
// client renders the translation of the key and keeps the English text only for
// a file whose key it has no translation for.

import { test, expect } from "@playwright/test";
import { seedLibrary } from "./helpers.mjs";

const LOG_NAME = "stemdeck.log";
const ENGLISH_DESCRIPTION = "Application log: the pipeline, API and job activity. Rotates at 5 MB, 3 kept.";
const GERMAN_DESCRIPTION = "Anwendungsprotokoll";
const UNKNOWN_FILE_DESCRIPTION = "A log file this build has no translation for.";

const logFile = (name, description, descriptionKey) => ({
  name,
  description,
  description_key: descriptionKey,
  path: `/logs/${name}`,
  exists: true,
  size: 1024,
  modified: 1_700_000_000,
});

/** Serve a fixed file list so the test does not depend on which logs the server has written. */
async function serveLogFiles(page, files) {
  await page.route("**/api/logs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dir: "/logs", dir_exists: true, files }),
    }),
  );
}

async function openLogsTab(page, language) {
  await page.addInitScript(
    (code) => localStorage.setItem("stemdeck.language", JSON.stringify(code)),
    language,
  );
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  await page.locator('.settings-tab[data-tab="logs"]').click();
}

const descriptionOf = (page, name) =>
  page.locator(".settings-log-row", { hasText: name }).locator(".settings-log-desc");

test.describe("log file descriptions", () => {
  test("show in the selected language", async ({ page }) => {
    await serveLogFiles(page, [logFile(LOG_NAME, ENGLISH_DESCRIPTION, `settings.logs.file.${LOG_NAME}`)]);
    await openLogsTab(page, "de");

    await expect(descriptionOf(page, LOG_NAME)).toContainText(GERMAN_DESCRIPTION);
    await expect(descriptionOf(page, LOG_NAME)).not.toContainText("Application log");
  });

  test("fall back to the English text when the key has no translation", async ({ page }) => {
    await serveLogFiles(page, [logFile("new.log", UNKNOWN_FILE_DESCRIPTION, "settings.logs.file.new.log")]);
    await openLogsTab(page, "de");

    await expect(descriptionOf(page, "new.log")).toHaveText(UNKNOWN_FILE_DESCRIPTION);
  });
});
