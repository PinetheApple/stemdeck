// The footer's practice group: Loop, Speed, Key, Click and Count-in, each with
// its icon over its label, coral when on, and its options a click away.

import { test, expect } from "@playwright/test";
import {
  openKeyOptions,
  openLoopOptions,
  openSpeedOptions,
  openStudio,
  waitForClickTrack,
} from "./helpers.mjs";

const rate = (page) => page.evaluate(async () => (await import("/js/state.js")).playbackSpeed);
const countInBars = (page) => page.evaluate(async () => (await import("/js/state.js")).metronomeCountInBars);
const ON = /\bis-on\b/;
const LOOP_START = "0:02.000";
const LOOP_END = "0:06.500";

test("Speed steps by five hundredths with - and + and stops at the ends", async ({ page }) => {
  await openStudio(page);
  const readout = page.locator("#t-speed-readout");
  await expect(readout).toHaveText("1.00×");
  await expect(page.locator("#t-speed-up")).toBeDisabled();
  await page.locator("#t-speed-down").click();
  await expect(readout).toHaveText("0.95×");
  await expect.poll(() => rate(page)).toBe(0.95);
  await expect(page.locator("#footerSpeed")).toHaveClass(ON);
  await page.locator("#t-speed-up").click();
  await expect(readout).toHaveText("1.00×");
  await expect(page.locator("#footerSpeed")).not.toHaveClass(ON);
});

test("clicking Speed's value opens the exact box; a double-click toggles 1x and the slow speed", async ({ page }) => {
  await openStudio(page);
  await openSpeedOptions(page);
  await page.locator("#t-speed-value").fill("0.8");
  await page.locator("#t-speed-value").press("Enter");
  await expect(page.locator("#t-speed-readout")).toHaveText("0.80×");
  await page.keyboard.press("Escape");
  await expect(page.locator("#t-speed-panel")).toBeHidden();

  await page.locator("#t-speed-btn").dblclick();
  await expect.poll(() => rate(page)).toBe(1);
  await page.locator("#t-speed-btn").dblclick();
  await expect.poll(() => rate(page)).toBe(0.8);
  await expect(page.locator("#t-speed-readout")).toHaveText("0.80×");
});

test("Key steps with - and +; its value opens Reset and a double-click resets every lane", async ({ page }) => {
  await openStudio(page);
  await expect(page.locator("#t-pitch-up")).toBeEnabled({ timeout: 20000 });
  await page.locator("#t-pitch-up").click();
  await expect(page.locator("#t-pitch-value")).toHaveText("+1");
  await expect(page.locator("#t-pitch-wrap")).toHaveClass(ON);

  await openKeyOptions(page);
  await expect(page.locator("#t-pitch-reset")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.locator("#t-key-btn").dblclick();
  await expect(page.locator("#t-pitch-value")).toHaveText("0");
  await expect(page.locator("#t-pitch-wrap")).not.toHaveClass(ON);
});

test("Loop's options hold the exact start and end fields, and typing in them arms the loop", async ({ page }) => {
  await openStudio(page);
  await expect(page.locator("#t-loop-start")).toBeHidden();
  await openLoopOptions(page);
  await page.locator("#t-loop-end").fill(LOOP_END);
  await page.locator("#t-loop-end").press("Enter");
  await page.locator("#t-loop-start").fill(LOOP_START);
  await page.locator("#t-loop-start").press("Enter");
  await expect(page.locator("#t-loop")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#footerLoop")).toHaveClass(ON);
  await expect(page.locator("#t-loop-start")).toHaveValue(/^(\d+:)?0?2\.000$/);

  await page.keyboard.press("Escape");
  await expect(page.locator("#t-loop-panel")).toBeHidden();
  await expect(page.locator("#t-loop-more")).toBeFocused();
});

test("L, K and the footer's Click button switch Loop and the click", async ({ page }) => {
  await openStudio(page);
  await waitForClickTrack(page, { revealOptions: false });
  await page.locator("body").press("l");
  await expect(page.locator("#t-loop")).toHaveAttribute("aria-pressed", "true");

  const click = page.locator("#t-click");
  await expect(click).toBeEnabled();
  await click.click();
  await expect(click).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#footerClick")).toHaveClass(ON);
  await expect(page.locator("#t-metro")).toHaveAttribute("aria-pressed", "true");
  await page.locator("body").press("k");
  await expect(click).toHaveAttribute("aria-pressed", "false");
});

test("Click's options set volume, accent and sound for the click track", async ({ page }) => {
  await openStudio(page);
  await waitForClickTrack(page, { revealOptions: false });
  await page.locator("#t-click-more").click();
  const panel = page.locator("#t-click-panel");
  await expect(panel).toBeVisible();

  await page.locator("#t-click-sound").selectOption({ index: 1 });
  await expect.poll(() => page.locator("#t-metro-sound").inputValue())
    .toBe(await page.locator("#t-click-sound").inputValue());

  await page.locator("#t-click-accent").selectOption("7");
  await expect(page.locator("#t-click-groups")).toBeVisible();
  await expect(page.locator("#t-metro-bar")).toHaveValue("7");

  await page.locator("#t-click-vol").fill("0.3");
  await expect(page.locator("#t-metro-vol")).toHaveValue("0.3");
});

test("Count-in offers off or 1 to 4 bars with its caption, and names what is on", async ({ page }) => {
  await openStudio(page);
  const button = page.locator("#t-countin");
  await button.click();
  const menu = page.locator("#t-countin-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator("[role=menuitemradio]")).toHaveCount(5);
  await expect(menu).toContainText("Plays even with the click track off");
  await menu.locator('[data-bars="2"]').click();
  await expect(menu).toBeHidden();
  await expect(button).toContainText("2 bars");
  await expect(page.locator("#footerCountIn")).toHaveClass(ON);
  await expect.poll(() => countInBars(page)).toBe(2);
  await expect(page.locator("#t-metro-countin")).toHaveValue("2");
});
