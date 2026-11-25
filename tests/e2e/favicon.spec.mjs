// The tab icon (#266): both shells declare the waveform mark and the server serves it.

import { test, expect } from "@playwright/test";

const SHELLS = ["/?ui=desktop", "/?ui=mobile"];

for (const path of SHELLS) {
  test(`${path} declares an icon the server serves`, async ({ page }) => {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const href = await page.locator('head link[rel="icon"]').getAttribute("href");
    const icon = await page.request.get(href);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  });
}
