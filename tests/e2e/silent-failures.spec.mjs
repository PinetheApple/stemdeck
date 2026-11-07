// Failures that used to look like success (#39).
//
// A browser export was a bare <a download>: a failed render produced no file
// and no message.

import { test, expect } from "@playwright/test";
import { openStudio, exportUi } from "./helpers.mjs";

const STEMS_ZIP = "**/api/jobs/*/stems/all.zip**";
const notifCard = (page, title) =>
  page.locator("#notifList .daw-notif-error .daw-notif-card-title", { hasText: title });

test.describe("a browser export", () => {
  test("a server error says so and leaves the menu usable", async ({ page }) => {
    await openStudio(page);
    await page.route(STEMS_ZIP, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "boom" }) }));
    const ui = exportUi(page);

    await ui.open();
    await ui.stems.click();

    await expect(ui.error).toContainText("Export failed");
    await expect(notifCard(page, "Export failed")).toHaveCount(1);
    await expect(ui.label).toHaveText("Export Mix");
    await expect(ui.stems).not.toHaveAttribute("aria-disabled", "true");
  });

  test("a dropped connection says so", async ({ page }) => {
    await openStudio(page);
    await page.route(STEMS_ZIP, (route) => route.abort("connectionreset"));
    const ui = exportUi(page);

    await ui.open();
    await ui.stems.click();

    await expect(ui.error).toContainText("Export failed");
    await expect(notifCard(page, "Export failed")).toHaveCount(1);
  });

  test("a successful export still saves the file under its name", async ({ page }) => {
    await openStudio(page);
    await page.route(STEMS_ZIP, (route) =>
      route.fulfill({ status: 200, contentType: "application/zip", body: Buffer.from("PK") }));
    const ui = exportUi(page);

    await ui.open();
    const download = page.waitForEvent("download");
    await ui.stems.click();

    expect((await download).suggestedFilename()).toMatch(/_stems\.zip$/);
    await expect(ui.error).toHaveCount(0);
    await expect(ui.label).toHaveText("Export Mix");
  });
});
