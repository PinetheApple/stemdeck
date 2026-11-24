import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  KEY,
  OUTSIDE_DIALOG,
  browseRow,
  chooseFromSongMenu,
  openBrowse,
  openStudio,
  settleRoutes,
} from "./helpers.mjs";
import { openSettings } from "./settingsHelpers.mjs";

test.afterEach(settleRoutes);

function dialogLook(page, scrim, card, title) {
  return page.evaluate(
    ([scrimSel, cardSel, titleSel]) => {
      const s = getComputedStyle(document.querySelector(scrimSel));
      const c = getComputedStyle(document.querySelector(cardSel));
      const h = getComputedStyle(document.querySelector(titleSel));
      return {
        title: `${h.fontFamily} ${h.fontSize} ${h.fontWeight}`,
        dim: s.backgroundColor,
        position: s.position,
        card: c.backgroundColor,
        border: `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
        radius: c.borderTopLeftRadius,
        shadow: c.boxShadow,
      };
    },
    [scrim, card, title],
  );
}

const CONFIRM = { title: "Import this song again?", name: "A song", body: "Body", confirmLabel: "Import again" };
const ABOUT_SONG = "About this song";

/** Whether the element is what a press at its centre lands on. */
function isOnTop(locator) {
  return locator.evaluate(function hitsItself(el) {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
}

test("Settings, Something failed, New release, About the song, a confirm card and Extract more look alike", async ({ page }) => {
  await openStudio(page, { updateAvailable: true });
  const looks = {};

  await openSettings(page);
  looks.settings = await dialogLook(page, ".library-editor-backdrop", ".library-editor", ".library-editor-head > span");
  await page.keyboard.press(KEY.ESCAPE);

  await page.evaluate(() =>
    import("/js/notifications.js").then((m) => m.notifyFailure({ kind: "export", message: "disk full" })),
  );
  await page.locator("#notifBtn").click();
  await page.locator(".daw-notif-error").first().click();
  await expect(page.locator("#failureDialog")).toBeVisible();
  looks.failure = await dialogLook(page, "#failureDialog", "#failureDialog .about-card", "#failureTitle");
  await page.keyboard.press(KEY.ESCAPE);

  await page.locator("#notifReleaseCard").click();
  await expect(page.locator("#releaseDialog")).toBeVisible();
  looks.release = await dialogLook(page, "#releaseDialog", "#releaseDialog .about-card", "#releaseDialog .dialog-title");
  await page.keyboard.press(KEY.ESCAPE);
  await page.keyboard.press(KEY.ESCAPE);

  await page.locator("#np-details-btn").click();
  await expect(page.locator("#artistDialog")).toBeVisible();
  looks.artist = await dialogLook(page, "#artistDialog", "#artistDialog .about-card", "#artistDialog .dialog-title");
  await page.keyboard.press(KEY.ESCAPE);

  await page.evaluate((options) => {
    import("/js/confirmDialog.js").then((m) => m.confirmDialog(options));
  }, CONFIRM);
  await expect(page.locator(".reset-confirm-card")).toBeVisible();
  looks.confirm = await dialogLook(page, ".reset-confirm-backdrop", ".reset-confirm-card", ".reset-confirm-card .dialog-title");
  await page.keyboard.press(KEY.ESCAPE);

  await page.evaluate((id) => {
    document.dispatchEvent(new CustomEvent("versions:extract", { detail: { id } }));
  }, JOB_ID);
  await expect(page.locator(".extract-more-card")).toBeVisible();
  looks.extract = await dialogLook(page, ".extract-more-backdrop", ".extract-more-card", ".extract-more-card .dialog-title");

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
  await expect(page.locator("#failureDialog")).toBeVisible();
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

  await page.mouse.click(OUTSIDE_DIALOG.x, OUTSIDE_DIALOG.y);
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

test("a confirm card has the shared head row, and its close button answers no", async ({ page }) => {
  await openStudio(page);
  const answer = page.evaluate((options) => import("/js/confirmDialog.js").then((m) => m.confirmDialog(options)), CONFIRM);
  const head = page.locator(".reset-confirm-card .dialog-head");
  await expect(head.locator(".dialog-title")).toHaveText(CONFIRM.title);
  const close = head.locator(".dialog-close");
  await expect(close).toHaveAttribute("aria-label", /\S/);
  await close.click();
  await expect(page.locator(".reset-confirm-card")).toHaveCount(0);
  expect(await answer).toBe(false);
});

test("Esc closes a confirm card opened from Settings, and only it, back to Settings", async ({ page }) => {
  await openStudio(page);
  await openSettings(page);
  const tab = page.locator('.settings-tab[data-tab="general"]');
  await expect(tab).toBeFocused();
  await page.evaluate((options) => {
    import("/js/confirmDialog.js").then((m) => m.confirmDialog(options));
  }, CONFIRM);
  await expect(page.locator(".reset-confirm-card")).toBeVisible();

  await page.keyboard.press(KEY.ESCAPE);
  await expect(page.locator(".reset-confirm-card")).toHaveCount(0);
  await expect(page.locator(".library-editor")).toBeVisible();
  await expect(tab).toBeFocused();
});

test("a dialog opened from Browse library, and a menu inside it, sit above Browse library", async ({ page }) => {
  await openStudio(page);
  await openBrowse(page);
  await chooseFromSongMenu(page, browseRow(page, JOB_ID), ABOUT_SONG);
  expect(await isOnTop(page.locator("#artistDialog .about-card"))).toBe(true);
  await page.keyboard.press(KEY.ESCAPE);

  await page.evaluate(() => import("/js/catalog.js").then((m) => m.openSettings("general")));
  expect(await isOnTop(page.locator(".library-editor"))).toBe(true);
  await page.locator("select.set-language").click();
  const menu = page.locator('[role="listbox"]:visible');
  await expect(menu).toBeVisible();
  expect(await isOnTop(menu)).toBe(true);
});
