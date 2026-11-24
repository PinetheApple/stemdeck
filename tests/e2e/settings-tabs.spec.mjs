// Settings is one dialog with its tabs down the left, Appearance first and About
// last, and it fits the smallest window the desktop app allows.

import { test, expect } from "@playwright/test";
import { seedLibrary, settleRoutes, stubUpdateCheck } from "./helpers.mjs";
import { SETTINGS_TABS, openSettings } from "./settingsHelpers.mjs";

test.afterEach(settleRoutes);

const TAB_LABELS = [
  "Appearance",
  "General",
  "Song details",
  "Network",
  "Export",
  "Recording",
  "Logs",
  "Library",
  "About",
];
const SETTINGS_WINDOW = { width: 1024, height: 720 };
const DATA_LINES = 9;
const SOCIAL_LINKS = 4;

async function openApp(page) {
  await seedLibrary(page);
  await stubUpdateCheck(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
}

const tabs = (page) => page.locator(".settings-nav .settings-tab");
const selectedTab = (page) => page.locator('.settings-nav .settings-tab[aria-selected="true"]');

test("the nine tabs run down the left of the dialog, Appearance open first", async ({ page }) => {
  await openApp(page);
  await page.locator("#settingsBtn").click();
  await expect(tabs(page)).toHaveText(TAB_LABELS);
  await expect(page.locator(".settings-nav")).toHaveAttribute("aria-orientation", "vertical");
  await expect(selectedTab(page)).toHaveAttribute("data-tab", "appearance");
  await expect(page.locator('.settings-pane[data-pane="appearance"]')).toBeVisible();

  const boxes = await tabs(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
  const pane = await page.locator('.settings-pane[data-pane="appearance"]').boundingBox();
  for (const [i, box] of boxes.entries()) {
    expect(box.left).toBeCloseTo(boxes[0].left, 0);
    expect(box.right).toBeLessThanOrEqual(pane.x);
    if (i) expect(box.top).toBeGreaterThan(boxes[i - 1].top);
  }
});

test("Up and Down move between the tabs and wrap; only the selected tab is a Tab stop", async ({ page }) => {
  await openApp(page);
  await page.locator("#settingsBtn").click();
  await selectedTab(page).focus();

  await page.keyboard.press("ArrowDown");
  await expect(selectedTab(page)).toHaveAttribute("data-tab", "general");
  await expect(selectedTab(page)).toBeFocused();
  await expect(page.locator('.settings-pane[data-pane="general"]')).toBeVisible();

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(selectedTab(page)).toHaveAttribute("data-tab", "about");
  await page.keyboard.press("Home");
  await expect(selectedTab(page)).toHaveAttribute("data-tab", "appearance");
  await expect(page.locator('.settings-nav .settings-tab[tabindex="0"]')).toHaveCount(1);
});

test("About is the last tab and has everything the About box had", async ({ page }) => {
  await openApp(page);
  const pane = await openSettings(page, "about");
  await expect(pane.locator("#aboutTitle")).toHaveText("StemDeck");
  await expect(pane.locator("#aboutVersion")).toHaveText(/^v\d/);
  await expect(pane.getByRole("link", { name: "Website" })).toHaveAttribute("href", "https://stemdeck.app");
  await expect(pane.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", /github\.com/);
  await expect(pane.locator(".about-social-btn")).toHaveCount(SOCIAL_LINKS);
  await expect(pane.locator(".about-credits")).toContainText("MusicBrainz");
  await expect(pane.locator(".about-license")).toContainText("GNU AGPL-3.0");
  await pane.locator("#aboutDataSummary").click();
  await expect(pane.locator("#aboutDataList li")).toHaveCount(DATA_LINES);
  await expect(page.locator("#aboutDialog")).toHaveCount(0);
});

test("Settings fits a 1024 x 720 window on every tab, Done in reach", async ({ page }) => {
  await page.setViewportSize(SETTINGS_WINDOW);
  await openApp(page);
  await page.locator("#settingsBtn").click();
  for (const name of SETTINGS_TABS) {
    await page.locator(`.settings-tab[data-tab="${name}"]`).click();
    const box = await page.locator(".library-editor").boundingBox();
    expect(box.x, name).toBeGreaterThanOrEqual(0);
    expect(box.y, name).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, name).toBeLessThanOrEqual(SETTINGS_WINDOW.width);
    expect(box.y + box.height, name).toBeLessThanOrEqual(SETTINGS_WINDOW.height);
    await expect(page.locator(".settings-done")).toBeInViewport();
  }
});
