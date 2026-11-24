// The Alerts panel opens from whatever trigger asks for it, stays in the window,
// closes on Esc or a click outside, and hands focus back to that trigger.

import { test, expect } from "@playwright/test";
import { KEY, seedLibrary, settleRoutes, stubUpdateCheck } from "./helpers.mjs";

test.afterEach(settleRoutes);

const SMALL_WINDOW = { width: 1024, height: 720 };
const panel = (page) => page.locator(".daw-notif-panel");

async function openApp(page) {
  await seedLibrary(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#notifBtn")).toBeVisible();
}

function notify(page, message) {
  return page.evaluate(
    (text) => import("/js/notifications.js").then((m) => m.notifyFailure({ kind: "export", message: text })),
    message,
  );
}

test("Esc closes the alerts and hands focus back to the bell", async ({ page }) => {
  await openApp(page);
  await page.locator("#notifBtn").click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator("#notifBtn")).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press(KEY.ESCAPE);
  await expect(panel(page)).toBeHidden();
  await expect(page.locator("#notifBtn")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#notifBtn")).toBeFocused();
});

test("a click outside closes the alerts", async ({ page }) => {
  await openApp(page);
  await page.locator("#notifBtn").click();
  await expect(panel(page)).toBeVisible();
  await page.mouse.click(SMALL_WINDOW.width / 2, SMALL_WINDOW.height / 2);
  await expect(panel(page)).toBeHidden();
});

test("the panel stays inside a small window", async ({ page }) => {
  await page.setViewportSize(SMALL_WINDOW);
  await openApp(page);
  for (let i = 0; i < 6; i += 1) await notify(page, `export ${i} failed`);
  await page.locator("#notifBtn").click();
  const box = await panel(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(SMALL_WINDOW.width);
  expect(box.y + box.height).toBeLessThanOrEqual(SMALL_WINDOW.height);
});

test("it opens from any trigger and goes back to that trigger", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() =>
    import("/js/alertsPanel.js").then((m) => m.openAlerts(document.getElementById("settingsBtn"))),
  );
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press(KEY.ESCAPE);
  await expect(panel(page)).toBeHidden();
  await expect(page.locator("#settingsBtn")).toBeFocused();
});

test("the bell's dot shows only while there is something to see", async ({ page }) => {
  await openApp(page);
  const dot = page.locator("#notifBadge");
  await expect(dot).toBeHidden();

  await notify(page, "disk full");
  await expect(dot).toBeVisible();
  await page.locator("#notifBtn").click();
  await page.locator(".daw-notif-error .daw-notif-dismiss").click();
  await expect(dot).toBeHidden();
  await expect(page.locator("#notifEmpty")).toBeVisible();
});
