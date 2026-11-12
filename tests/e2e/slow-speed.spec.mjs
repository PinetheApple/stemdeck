// The speed fader: any speed from 0.50x to 1.00x, by drag, wheel, keys or a typed value.
//
// The rate is applied once a drag or scroll settles, since every change of rate
// flushes the tempo stage. Every settled speed below 1x is remembered, and a
// double-click toggles between it and 1x.

import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

const fader = (page) => page.locator("#t-speed");
const box = (page) => page.locator("#t-speed-value");
const group = (page) => page.locator(".footer-group-speed");
const rate = (page) => page.evaluate(async () => (await import("/js/state.js")).playbackSpeed);
const appliedRates = (page) => page.evaluate(() => window.appliedRates);
const SLOWED = /\bslowed\b/;

// Every rate the engine is handed, so a test can tell one apply from many.
function recordAppliedRates(page) {
  return page.evaluate(async () => {
    const { audioEngine } = await import("/js/state.js");
    const apply = audioEngine.setPlaybackRate.bind(audioEngine);
    window.appliedRates = [];
    audioEngine.setPlaybackRate = function recordRate(next) {
      window.appliedRates.push(next);
      return apply(next);
    };
  });
}

async function typeSpeed(page, text) {
  await box(page).fill(text);
  await box(page).press("Enter");
}

test("dragging the fader shows the speed as it moves and applies it once it settles", async ({ page }) => {
  await openStudio(page);
  await expect(box(page)).toHaveValue("1.00x");
  await expect(group(page)).not.toHaveClass(SLOWED);
  await recordAppliedRates(page);

  const rect = await fader(page).boundingBox();
  const thumbAtOne = { x: rect.x + rect.width - 2, y: rect.y + rect.height / 2 };
  await page.mouse.move(thumbAtOne.x, thumbAtOne.y);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2, thumbAtOne.y, { steps: 8 });
  await page.mouse.up();

  await expect(box(page)).toHaveValue("0.75x");
  await expect(fader(page)).toHaveAttribute("aria-valuetext", "0.75x");
  await expect(group(page)).toHaveClass(SLOWED);
  await expect.poll(() => rate(page)).toBe(0.75);
  expect(await appliedRates(page)).toEqual([0.75]);
});

test("the wheel jumps from notch to notch and applies once the scrolling stops", async ({ page }) => {
  await openStudio(page);
  await recordAppliedRates(page);
  await fader(page).hover();
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 100);
  await expect(box(page)).toHaveValue("0.85x");
  await expect.poll(() => rate(page)).toBe(0.85);
  expect(await appliedRates(page)).toEqual([0.85]);

  await typeSpeed(page, "0.83");
  await fader(page).hover();
  await page.mouse.wheel(0, -100);
  await expect(box(page)).toHaveValue("0.85x");
});

test("the arrow keys move a hundredth, and five with Shift held", async ({ page }) => {
  await openStudio(page);
  await fader(page).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(box(page)).toHaveValue("0.99x");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(box(page)).toHaveValue("0.94x");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(box(page)).toHaveValue("0.89x");
  await page.keyboard.press("Shift+ArrowUp");
  await expect(box(page)).toHaveValue("0.94x");
  await page.keyboard.press("ArrowRight");
  await expect(box(page)).toHaveValue("0.95x");
  await expect.poll(() => rate(page)).toBe(0.95);
});

test("the box takes a speed in every form and ignores what isn't a number", async ({ page }) => {
  await openStudio(page);
  const forms = [
    ["0.83", 0.83],
    ["0,82", 0.82],
    ["0.81x", 0.81],
    ["80", 0.8],
    ["79%", 0.79],
    ["0.2", 0.5],
    ["1.5", 1],
  ];
  for (const [text, expected] of forms) {
    await typeSpeed(page, text);
    await expect(box(page)).toHaveValue(`${expected.toFixed(2)}x`);
    await expect.poll(() => rate(page)).toBe(expected);
  }

  await typeSpeed(page, "0.7");
  await typeSpeed(page, "fast");
  await expect(box(page)).toHaveValue("0.70x");
  expect(await rate(page)).toBe(0.7);
});

test("a double-click toggles between 1x and the last slow speed", async ({ page }) => {
  await openStudio(page);
  await typeSpeed(page, "0.8");
  await expect.poll(() => rate(page)).toBe(0.8);

  await fader(page).dblclick();
  await expect(box(page)).toHaveValue("1.00x");
  await expect.poll(() => rate(page)).toBe(1);

  await fader(page).dblclick();
  await expect(box(page)).toHaveValue("0.80x");
  await expect.poll(() => rate(page)).toBe(0.8);
});

test("the slow speed survives a reload, and a song still opens at 1x", async ({ page }) => {
  await openStudio(page);
  await typeSpeed(page, "0.7");
  await expect.poll(() => rate(page)).toBe(0.7);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(box(page)).toHaveValue("1.00x");
  await fader(page).dblclick();
  await expect(box(page)).toHaveValue("0.70x");
});
