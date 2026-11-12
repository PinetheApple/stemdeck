// Settings > General > Free memory when idle: the minutes the separation models
// stay loaded with nothing to do. The server owns the range and says what it kept.

import { test, expect } from "@playwright/test";
import { seedLibrary, uiText } from "./helpers.mjs";

const SETTINGS_URL = "**/api/settings";
const DEFAULT_MINUTES = 10;

async function openGeneral(page) {
  await seedLibrary(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#settingsBtn").click();
  const field = page.locator(".set-idle-unload");
  await expect(field).toHaveValue(/\d+/);
  return field;
}

function savedMinutes(request) {
  return request.get("/api/settings").then((r) => r.json()).then((d) => d.idle_unload_minutes);
}

async function failSaves(page) {
  const posts = [];
  await page.route(SETTINGS_URL, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts.push(route.request().postDataJSON());
    return route.fulfill({ status: 500, contentType: "application/json", body: '{"detail":"Could not save idle_unload_minutes"}' });
  });
  return posts;
}

test.describe("Free memory when idle", () => {
  test.afterEach(async ({ request }) => {
    await request.post("/api/settings", { data: { idle_unload_minutes: DEFAULT_MINUTES } });
  });

  test("shows the minutes in use and the server's ceiling", async ({ page, request }) => {
    const field = await openGeneral(page);
    const settings = await (await request.get("/api/settings")).json();
    await expect(field).toHaveValue(String(settings.idle_unload_minutes));
    const desc = await uiText(page, "settings.idleUnload.desc", { max: settings.idle_unload_minutes_max });
    await expect(page.locator(".set-idle-unload-desc")).toHaveText(desc);
    await expect(page.locator(".settings-row", { has: field }).locator(".settings-row-title"))
      .toHaveText(await uiText(page, "settings.idleUnload.title"));
  });

  test("a typed number is saved, 0 included", async ({ page, request }) => {
    const field = await openGeneral(page);
    await field.fill("0");
    await field.press("Enter");
    await expect.poll(() => savedMinutes(request)).toBe(0);
    await expect(page.locator(".idle-unload-msg")).toBeEmpty();
  });

  test("a number over the ceiling shows what was kept and says so", async ({ page, request }) => {
    const field = await openGeneral(page);
    const { idle_unload_minutes_max: max } = await (await request.get("/api/settings")).json();
    await field.fill("9999");
    await field.press("Enter");
    await expect(field).toHaveValue(String(max));
    await expect(page.locator(".idle-unload-msg")).toHaveText(await uiText(page, "settings.idleUnload.clamped", { max }));
  });

  test("a save that fails puts back the value in use and says so", async ({ page }) => {
    const field = await openGeneral(page);
    const before = await field.inputValue();
    await failSaves(page);
    await field.fill("45");
    await field.press("Enter");
    const msg = page.locator(".idle-unload-msg");
    await expect(msg).toHaveText(await uiText(page, "settings.idleUnload.saveFailed"));
    await expect(msg).toHaveClass(/\berror\b/);
    await expect(field).toHaveValue(before);
  });

  test("pasted text that is not a number is refused without saving", async ({ page }) => {
    const field = await openGeneral(page);
    const before = await field.inputValue();
    const posts = await failSaves(page);
    await field.focus();
    await field.evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/plain", "ten");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(page.locator(".idle-unload-msg")).toHaveText(await uiText(page, "settings.idleUnload.notNumber"));
    await expect(field).toHaveValue(before);
    expect(posts).toEqual([]);
  });
});
