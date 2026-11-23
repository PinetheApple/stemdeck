// Three draggable edges, each inside its limits and never squeezing the waveforms
// under their minimum; reset by double-click or Enter, moved by arrows, remembered.

import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";
import { MIN_WAVES_PX, PANE_LIMITS } from "../../static/js/paneEdgeMath.js";

const WIDE_WINDOW = { width: 1920, height: 1080 };
const KEY_STEP = 16;
const MIN_WAVES = MIN_WAVES_PX;
const FAR = 2000;
// Too narrow for the widest sidebar, stem column and song tools; wide enough for the first two.
const STEP_ASIDE_WINDOW = { width: 1400, height: 900 };
const EDGES = [
  { name: "sidebar", handle: "#libraryResizer", pane: "#catalogPanel", ...PANE_LIMITS.sidebar, grows: 1, key: "stemdeck.library.width" },
  { name: "stem controls", handle: "#stemsResizer", pane: ".daw-stems-panel", ...PANE_LIMITS.stems, grows: 1, key: "stemdeck.stems.width" },
  { name: "song tools", handle: "#inspectorResizer", pane: "#inspector", ...PANE_LIMITS.tools, grows: -1, key: "stemdeck.inspector.width" },
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

test("the song tools step aside before the stem column narrows", async ({ page }) => {
  const [sidebar, stems] = EDGES;
  await drag(page, stems.handle, FAR);
  await drag(page, sidebar.handle, FAR);
  await page.setViewportSize(STEP_ASIDE_WINDOW);
  await expect(page.locator("#inspector")).toBeHidden();
  await expect(page.locator("#inspectorToggleBtn")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => widthOf(page, stems.pane)).toBe(stems.max);
  expect(await widthOf(page, ".daw-wave-panel")).toBeGreaterThanOrEqual(MIN_WAVES);
});

test("all three at their widest still leave the waveforms 320px", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  for (const edge of EDGES) await drag(page, edge.handle, FAR * edge.grows);
  expect(await widthOf(page, ".daw-wave-panel")).toBeGreaterThanOrEqual(MIN_WAVES);
});
