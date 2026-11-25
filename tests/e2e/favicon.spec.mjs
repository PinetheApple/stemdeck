// Both shells declare the waveform mark as the tab icon, and the server serves it.

import { test, expect } from "@playwright/test";

const SHELLS = ["/?ui=desktop", "/?ui=mobile"];

for (const path of SHELLS) {
  test(`${path} declares an icon the server serves`, async ({ page }) => {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const href = await page.locator('head link[rel="icon"]').getAttribute("href");
    expect(href).toBe("/img/stemdeck-waveform-symbol.svg");
    const icon = await page.request.get(href);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  });
}
