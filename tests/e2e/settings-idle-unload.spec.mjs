import { test, expect } from "@playwright/test";
import { seedLibrary, uiText } from "./helpers.mjs";

const SETTINGS_URL = "**/api/settings";
const HTTP_SERVER_ERROR = 500;

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
  await page.route(SETTINGS_URL, (route) => {
    if (route.request().method() !== "POST") return route.continue();
    return route.fulfill({
      status: HTTP_SERVER_ERROR,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Could not save idle_unload_minutes" }),
    });
  });
}

test.describe("Free memory when idle", () => {
  let minutesBefore = null;
  test.beforeEach(async ({ request }) => {
    minutesBefore = await savedMinutes(request);
  });
  test.afterEach(async ({ request }) => {
    await request.post("/api/settings", { data: { idle_unload_minutes: minutesBefore } });
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
    const clamped = await uiText(page, "settings.idleUnload.clamped", { max });
    await expect(page.locator(".idle-unload-msg")).toHaveText(clamped);
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
});
