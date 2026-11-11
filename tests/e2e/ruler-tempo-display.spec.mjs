// The ruler and the Tempo tab stay readable while the song plays and scrolls.
//
// The ruler check compares pixels: a label painted with the playhead sitting
// inside it must look exactly like the same label with the playhead elsewhere.

import { test, expect } from "@playwright/test";
import { openStudio, openInspectorTab } from "./helpers.mjs";

const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 700 },
];
const PLAYHEAD_TOLERANCE_PX = 2;
const FAR_FROM_LABEL_FRAC = 0.9;
const TEMPO_SCROLL_PX = 24;

async function seekOnRuler(page, x) {
  const ruler = await page.locator("#ruler-time").boundingBox();
  await page.mouse.click(x, ruler.y + ruler.height - 2);
  await page.mouse.move(0, 0);
  await expect.poll(
    async () => {
      const flag = await page.locator("#ruler-time .playhead-marker svg").boundingBox();
      return Math.abs(flag.x + flag.width / 2 - x);
    },
  ).toBeLessThan(PLAYHEAD_TOLERANCE_PX);
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("the playhead flag leaves a ruler label readable", async ({ page }) => {
      await openStudio(page);
      const label = page.locator("#ruler-time .tick-label").first();
      const box = await label.boundingBox();

      await seekOnRuler(page, box.x + box.width / 2);
      const flag = await page.locator("#ruler-time .playhead-marker svg").boundingBox();
      expect(flag.y + flag.height).toBeLessThanOrEqual(box.y);
      const withPlayhead = await page.screenshot({ clip: box });

      const visibleRuler = await page.locator(".daw-ruler-area").boundingBox();
      await seekOnRuler(page, visibleRuler.x + visibleRuler.width * FAR_FROM_LABEL_FRAC);
      const withoutPlayhead = await page.screenshot({ clip: box });

      expect(withPlayhead.equals(withoutPlayhead)).toBe(true);
    });

    test("scrolled Tempo content stays clear of the tab bar", async ({ page }) => {
      await openStudio(page);
      await openInspectorTab(page, "tempo");
      const pane = page.locator('.inspector-pane[data-pane="tempo"]');
      await pane.hover();
      await page.mouse.wheel(0, TEMPO_SCROLL_PX);
      await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

      const layout = await pane.evaluate((el) => {
        const tabs = document.querySelector(".inspector-tabs");
        const paneTop = el.getBoundingClientRect().top;
        const firstVisible = [...el.children]
          .map((child) => child.getBoundingClientRect())
          .find((rect) => rect.bottom > paneTop);
        const opaque = new OffscreenCanvas(1, 1).getContext("2d");
        opaque.fillStyle = getComputedStyle(tabs).backgroundColor;
        opaque.fillRect(0, 0, 1, 1);
        return {
          contentTop: Math.max(firstVisible.top, paneTop),
          tabsBottom: tabs.getBoundingClientRect().bottom,
          tabsAlpha: opaque.getImageData(0, 0, 1, 1).data[3],
          edgeMask: getComputedStyle(el).maskImage,
        };
      });
      expect(layout.contentTop).toBeGreaterThanOrEqual(layout.tabsBottom);
      expect(layout.tabsAlpha).toBe(255);
      expect(layout.edgeMask).toContain("gradient");
    });
  });
}
