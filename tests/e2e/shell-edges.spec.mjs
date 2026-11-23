// Three draggable edges (#233): sidebar, stem controls column and song tools.
// Each stays inside its limits, never squeezes the waveforms under 320px,
// resets on double-click or Enter, moves 16px per arrow key, and is remembered.

import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

const WIDE_WINDOW = { width: 1920, height: 1080 };
const KEY_STEP = 16;
const MIN_WAVES = 320;
const FAR = 2000;
const EDGES = [
  { name: "sidebar", handle: "#libraryResizer", pane: "#catalogPanel", min: 232, max: 380, grows: 1, key: "stemdeck.library.width" },
  { name: "stem controls", handle: "#stemsResizer", pane: ".daw-stems-panel", min: 328, max: 480, grows: 1, key: "stemdeck.stems.width" },
  { name: "song tools", handle: "#inspectorResizer", pane: "#inspector", min: 320, max: 520, grows: -1, key: "stemdeck.inspector.width" },
];

const widthOf = async (page, selector) => (await page.locator(selector).first().boundingBox()).width;
const saved = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), key);

async function drag(page, handle, dx) {
  const box = await page.locator(handle).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 6 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(WIDE_WINDOW);
  await openStudio(page);
});

for (const edge of EDGES) {
  test.describe(`the ${edge.name} edge`, () => {
    test("stops at its limits", async ({ page }) => {
      await drag(page, edge.handle, -FAR * edge.grows);
      await expect.poll(() => widthOf(page, edge.pane)).toBe(edge.min);
      await drag(page, edge.handle, FAR * edge.grows);
      await expect.poll(() => widthOf(page, edge.pane)).toBe(edge.max);
      expect(await widthOf(page, ".daw-wave-panel")).toBeGreaterThanOrEqual(MIN_WAVES);
    });

    test("arrow keys move it 16px, Enter and double-click reset it", async ({ page }) => {
      const start = await widthOf(page, edge.pane);
      await page.locator(edge.handle).focus();
      await page.keyboard.press(edge.grows > 0 ? "ArrowRight" : "ArrowLeft");
      await expect.poll(() => widthOf(page, edge.pane)).toBe(start + KEY_STEP);
      await page.keyboard.press("Enter");
      await expect.poll(() => widthOf(page, edge.pane)).toBe(start);
      await drag(page, edge.handle, -FAR * edge.grows);
      await page.locator(edge.handle).dblclick();
      await expect.poll(() => widthOf(page, edge.pane)).toBe(start);
    });

    test("is remembered", async ({ page }) => {
      await drag(page, edge.handle, FAR * edge.grows);
      await expect.poll(() => saved(page, edge.key)).toBe(edge.max);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect.poll(() => widthOf(page, edge.pane)).toBe(edge.max);
    });
  });
}

test("all three at their widest still leave the waveforms 320px", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  for (const edge of EDGES) await drag(page, edge.handle, FAR * edge.grows);
  expect(await widthOf(page, ".daw-wave-panel")).toBeGreaterThanOrEqual(MIN_WAVES);
});
