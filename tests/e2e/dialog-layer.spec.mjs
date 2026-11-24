// Every dialog has one look and one behaviour: the page dims behind it, Esc or a
// press outside closes it, and focus goes back to what opened it. A dialog opened
// from Settings closes back to Settings.

import { test, expect } from "@playwright/test";
import { KEY, openStudio, settleRoutes } from "./helpers.mjs";
import { openSettings } from "./settingsHelpers.mjs";

test.afterEach(settleRoutes);

/** Scrim and card look of the dialog whose scrim matches `scrim`. */
function dialogLook(page, scrim, card) {
  return page.evaluate(
    ([scrimSel, cardSel]) => {
      const s = getComputedStyle(document.querySelector(scrimSel));
      const c = getComputedStyle(document.querySelector(cardSel));
      return {
        dim: s.backgroundColor,
        position: s.position,
        card: c.backgroundColor,
        border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
        radius: c.borderTopLeftRadius,
        shadow: c.boxShadow,
      };
    },
    [scrim, card],
  );
}

const CONFIRM = { title: "Import this song again?", name: "A song", body: "Body", confirmLabel: "Import again" };

test("Settings, Something failed, New release, About the song and a confirm card look alike", async ({ page }) => {
  await openStudio(page, { updateAvailable: true });
  const looks = {};

  await openSettings(page);
  looks.settings = await dialogLook(page, ".library-editor-backdrop", ".library-editor");
  await page.keyboard.press(KEY.ESCAPE);

  await page.evaluate(() =>
    import("/js/notifications.js").then((m) => m.notifyFailure({ kind: "export", message: "disk full" })),
  );
  await page.locator("#notifBtn").click();
  await page.locator(".daw-notif-error").first().click();
  looks.failure = await dialogLook(page, "#failureDialog", "#failureDialog .about-card");
  await page.keyboard.press(KEY.ESCAPE);

  await page.locator("#notifReleaseCard").click();
  looks.release = await dialogLook(page, "#releaseDialog", "#releaseDialog .about-card");
  await page.keyboard.press(KEY.ESCAPE);
  await page.keyboard.press(KEY.ESCAPE);

  await page.locator("#np-details-btn").click();
  looks.artist = await dialogLook(page, "#artistDialog", "#artistDialog .about-card");
  await page.keyboard.press(KEY.ESCAPE);

  await page.evaluate((options) => {
    import("/js/confirmDialog.js").then((m) => m.confirmDialog(options));
  }, CONFIRM);
  await expect(page.locator(".reset-confirm-card")).toBeVisible();
  looks.confirm = await dialogLook(page, ".reset-confirm-backdrop", ".reset-confirm-card");

  expect(looks.settings.position).toBe("fixed");
  for (const [name, look] of Object.entries(looks)) expect(look, name).toEqual(looks.settings);
});

test("each dialog's head puts its title on the left and its close button on the right", async ({ page }) => {
  await openStudio(page);
  await page.evaluate(() =>
    import("/js/notifications.js").then((m) => m.notifyFailure({ kind: "export", message: "disk full" })),
  );
  await page.locator("#notifBtn").click();
  await page.locator(".daw-notif-error").first().click();
  const title = await page.locator("#failureTitle").boundingBox();
  const close = await page.locator("#failureClose").boundingBox();
  const card = await page.locator("#failureDialog .about-card").boundingBox();
  expect(title.x - card.x).toBeLessThan(card.width / 4);
  expect(Math.abs(title.y + title.height / 2 - (close.y + close.height / 2))).toBeLessThan(close.height);
  expect(close.x).toBeGreaterThan(card.x + card.width / 2);
});

test("a press on the dimmed page closes only the dialog on top, back to Settings", async ({ page }) => {
  await openStudio(page);
  const general = await openSettings(page);
  const reset = general.locator(".settings-reset-btn");
  await reset.scrollIntoViewIfNeeded();
  await reset.click();
  await expect(page.locator(".reset-confirm-card")).toBeVisible();

  await page.mouse.click(5, 5);
  await expect(page.locator(".reset-confirm-card")).toHaveCount(0);
  await expect(page.locator(".library-editor")).toBeVisible();
  await expect(reset).toBeFocused();

  await page.keyboard.press(KEY.ESCAPE);
  await expect(page.locator(".library-editor")).toHaveCount(0);
});

test("openSettings(tab) lands on that tab, and Esc there closes Settings", async ({ page }) => {
  await openStudio(page);
  await page.evaluate(() => import("/js/catalog.js").then((m) => m.openSettings("details")));
  await expect(page.locator('.settings-tab[data-tab="details"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.settings-pane[data-pane="details"]')).toBeVisible();
  await page.keyboard.press(KEY.ESCAPE);
  await expect(page.locator(".library-editor")).toHaveCount(0);
});
