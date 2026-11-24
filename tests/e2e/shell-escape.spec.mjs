// One Esc order for the shell: error box, menu or popover, dialog, Guide, Stage
// mode. Dialogs dim the page, popovers stay in the window, Guide explains the shell.

import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";
import { openSettings } from "./settingsHelpers.mjs";

const SHORT_WINDOW = { width: 1024, height: 240 };
const EDGE_PX = 8;
const MIN_SCRIM_ALPHA = 0.4;
const QUEUED_ID = "e2e0q0000001";
const GUIDE_CONTROLS = [
  "#sidebarCollapseBtn", ".topbar-brand", "#addSongBtn", "#notifBtn", "#helpModeBtn", "#aboutBtn",
  "#settingsBtn", "#inspectorToggleBtn", "#libraryResizer", "#stemsResizer", "#inspectorResizer",
  "#browseBtn", "#sidebarFavorites .sidebar-group-head", "#sidebarImporting .sidebar-group-head", "#trashBtn", '.inspector-tab[data-tab="lyrics"]',
  "#importingBtn", "#connStatus",
];
const COLLAPSED_GUIDE_CONTROLS = [
  ".strip-nav-browse", ".strip-nav-trash", "#catalogStrip .strip-thumb",
];

const guideOn = (page) => page.locator("body").evaluate((el) => el.classList.contains("help-mode"));
const stageOn = (page) => page.locator(".app").evaluate((el) => el.classList.contains("stage-mode"));
const settingsDialog = (page) => page.locator(".library-editor");
const listbox = (page) => page.locator('[role="listbox"]:visible');
const confirmCard = (page) => page.locator(".reset-confirm-card");

const setGuide = (page, on) => page.evaluate(async (value) => (await import("/js/helpMode.js")).setHelpMode(value), on);
const showError = (page) => page.evaluate(async () => (await import("/js/job.js")).showError("Something failed."));
const askConfirm = (page) => page.evaluate(async () => {
  (await import("/js/confirmDialog.js")).confirmDialog({ title: "Remove it?", name: "It", body: "", confirmLabel: "Remove" });
});

async function stubQueue(page) {
  const job = { job_id: QUEUED_ID, status: "queued", title: QUEUED_ID, source_url: "https://example.com/a" };
  await page.route("**/api/queue", (route) => route.fulfill({ json: { running: null, queued: [job], paused: false } }));
  await page.route("**/api/queue/events", (route) => route.abort());
  await page.evaluate(async () => (await import("/js/queue.js")).refreshQueue());
}

async function openSettingsMenu(page) {
  const general = await openSettings(page);
  await general.locator("select.set-language").click();
  await expect(listbox(page)).toBeVisible();
}

function alphaOf(color) {
  const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return parts.length === 4 ? parts[3] : parts.length === 3 ? 1 : 0;
}

test.describe("Esc closes the topmost thing only", () => {
  test("a dialog, then Guide, then Stage mode, one per Esc", async ({ page }) => {
    await openStudio(page);
    await page.keyboard.press("f");
    expect(await stageOn(page)).toBe(true);
    await setGuide(page, true);
    await askConfirm(page);
    await expect(confirmCard(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(confirmCard(page)).toHaveCount(0);
    expect(await guideOn(page)).toBe(true);
    expect(await stageOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await guideOn(page)).toBe(false);
    expect(await stageOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await stageOn(page)).toBe(false);
  });

  test("a menu inside Settings closes before Settings", async ({ page }) => {
    await openStudio(page);
    await openSettingsMenu(page);
    await page.keyboard.press("Escape");
    await expect(listbox(page)).toHaveCount(0);
    await expect(settingsDialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settingsDialog(page)).toHaveCount(0);
  });

  test("the error box closes before a menu and its dialog", async ({ page }) => {
    await openStudio(page);
    await openSettingsMenu(page);
    await showError(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#error")).toBeHidden();
    await expect(listbox(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(listbox(page)).toHaveCount(0);
    await expect(settingsDialog(page)).toBeVisible();
  });

  test("a dialog over Browse library closes first, then Browse library, then Guide", async ({ page }) => {
    await openStudio(page);
    await page.locator("#browseBtn").click();
    await expect(page.locator("#browseLibrary")).toBeVisible();
    await setGuide(page, true);
    await askConfirm(page);
    await expect(confirmCard(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(confirmCard(page)).toHaveCount(0);
    await expect(page.locator("#browseLibrary")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#browseLibrary")).toBeHidden();
    expect(await guideOn(page)).toBe(true);
    await page.keyboard.press("Escape");
    expect(await guideOn(page)).toBe(false);
  });

  test("a popover before Guide, and Alerts closes on Esc", async ({ page }) => {
    await openStudio(page);
    await page.locator("#notifBtn").click();
    await expect(page.locator(".daw-notif-panel")).toBeVisible();
    await setGuide(page, true);
    await page.keyboard.press("Escape");
    await expect(page.locator(".daw-notif-panel")).toBeHidden();
    expect(await guideOn(page)).toBe(true);
  });
});

test.describe("dialogs and popovers", () => {
  test("Settings, About and a confirmation dim the page with the one scrim", async ({ page }) => {
    await openStudio(page);
    const scrim = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--scrim").trim());
    const opened = [
      [() => page.locator("#settingsBtn").click(), ".library-editor-backdrop"],
      [() => page.locator("#aboutBtn").click(), ".library-editor-backdrop"],
      [() => askConfirm(page), ".reset-confirm-backdrop"],
    ];
    for (const [open, backdrop] of opened) {
      await open();
      await expect(page.locator(backdrop)).toBeVisible();
      const color = await page.locator(backdrop).evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(color, backdrop).toBe(scrim);
      expect(alphaOf(color), backdrop).toBeGreaterThanOrEqual(MIN_SCRIM_ALPHA);
      await page.keyboard.press("Escape");
      await expect(page.locator(backdrop)).toBeHidden();
    }
  });

  test("Alerts stays inside a short window and scrolls inside itself", async ({ page }) => {
    await openStudio(page, { updateAvailable: true });
    await page.setViewportSize(SHORT_WINDOW);
    await page.locator("#notifBtn").click();
    const panel = page.locator(".daw-notif-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(EDGE_PX - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(SHORT_WINDOW.height - EDGE_PX + 1);
    expect(box.x + box.width).toBeLessThanOrEqual(SHORT_WINDOW.width);
    expect(["auto", "scroll"]).toContain(await panel.evaluate((el) => getComputedStyle(el).overflowY));
  });

  test("a song's menu stays inside a short window and scrolls inside itself", async ({ page }) => {
    await openStudio(page);
    await page.setViewportSize(SHORT_WINDOW);
    await page.locator("#songMoreBtn").click();
    const menu = page.locator(".lib-menu");
    await expect(menu).toBeVisible();
    await expect.poll(async () => {
      const box = await menu.boundingBox();
      return box.y >= 0 && box.y + box.height <= SHORT_WINDOW.height;
    }).toBe(true);
    expect(["auto", "scroll"]).toContain(await menu.evaluate((el) => getComputedStyle(el).overflowY));
  });
});

test.describe("Guide and the shell", () => {
  async function explainsEach(page, selectors) {
    for (const selector of selectors) {
      await page.locator(selector).first().hover({ force: true });
      await expect(page.locator("#helpTip"), selector).toBeVisible();
      await expect(page.locator("#helpTip"), selector).not.toBeEmpty();
    }
  }

  test("explains every control of the shell", async ({ page }) => {
    await openStudio(page);
    await stubQueue(page);
    await page.locator("#connStatus").evaluate((el) => el.classList.remove("hidden"));
    await page.locator("#helpModeBtn").click();
    await explainsEach(page, GUIDE_CONTROLS);
  });

  test("explains the collapsed sidebar, imports running", async ({ page }) => {
    await openStudio(page);
    await stubQueue(page);
    await page.locator("#sidebarCollapseBtn").click();
    await page.locator("#helpModeBtn").click();
    await explainsEach(page, COLLAPSED_GUIDE_CONTROLS);
  });

  test("leaving by the button or by Esc removes the tooltip", async ({ page }) => {
    await openStudio(page);
    const tip = page.locator("#helpTip");
    await page.locator("#helpModeBtn").click();
    await page.locator("#settingsBtn").hover();
    await expect(tip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tip).toBeHidden();
    await page.locator("#helpModeBtn").click();
    await page.locator("#helpModeBtn").hover();
    await page.locator("#helpModeBtn").click();
    await expect(tip).toBeHidden();
    await page.mouse.move(1, 1);
    await page.locator("#settingsBtn").hover();
    await expect(tip).toBeHidden();
  });
});
