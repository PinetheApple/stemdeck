// The ruler and the Tempo tab stay readable while the song plays and scrolls.

import { test, expect } from "@playwright/test";
import { openStudio, openInspectorTab } from "./helpers.mjs";

const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1440, height: 700 },
];
const PLAYHEAD_TOLERANCE_PX = 2;
const FAR_FROM_LABEL_FRAC = 0.9;
const RULER_CLICK_INSET_PX = 2;
const TEMPO_SCROLL_PX = 40;
const SCROLL_TIMELINE_CONDITION = "animation-timeline: scroll()";

async function seekOnRuler(page, x) {
  const ruler = await page.locator("#ruler-time").boundingBox();
  await page.mouse.click(x, ruler.y + ruler.height - RULER_CLICK_INSET_PX);
  await page.mouse.move(0, 0);
  await expect.poll(
    async () => {
      const flag = await page.locator("#ruler-time .playhead-marker svg").boundingBox();
      return Math.abs(flag.x + flag.width / 2 - x);
    },
  ).toBeLessThan(PLAYHEAD_TOLERANCE_PX);
}

/** Swap each scroll-timeline @supports block for its @supports-not fallback, as an engine without them would. */
function applyScrollTimelineFallback(timelineCondition) {
  let fallbacks = 0;
  for (const sheet of document.styleSheets) {
    const rules = [...sheet.cssRules];
    for (let index = rules.length - 1; index >= 0; index--) {
      const rule = rules[index];
      if (!(rule instanceof CSSSupportsRule) || !rule.conditionText.includes(timelineCondition)) continue;
      sheet.deleteRule(index);
      if (!rule.conditionText.startsWith("not")) continue;
      [...rule.cssRules].reverse().forEach((inner) => sheet.insertRule(inner.cssText, index));
      fallbacks++;
    }
  }
  return fallbacks;
}

function contentCrossesPaneTop(pane) {
  const paneTop = pane.getBoundingClientRect().top;
  return [...pane.children].some((child) => {
    const rect = child.getBoundingClientRect();
    return rect.top < paneTop && rect.bottom > paneTop;
  });
}

async function expectTempoPaddingClearWhenScrolled(page, { withoutScrollTimeline = false } = {}) {
  await openStudio(page);
  if (withoutScrollTimeline) {
    expect(await page.evaluate(applyScrollTimelineFallback, SCROLL_TIMELINE_CONDITION)).toBeGreaterThan(0);
  }
  await openInspectorTab(page, "tempo");
  const pane = page.locator('.inspector-pane[data-pane="tempo"]');
  const band = await pane.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const padding = parseFloat(getComputedStyle(el).paddingTop);
    return { x: rect.left, y: Math.floor(rect.top), width: el.clientWidth, height: Math.floor(padding) };
  });
  const atRest = await page.screenshot({ clip: band });

  await pane.hover();
  await page.mouse.wheel(0, TEMPO_SCROLL_PX);
  await expect.poll(
    () => pane.evaluate(contentCrossesPaneTop),
  ).toBe(true);
  await expect.poll(
    async () => (await page.screenshot({ clip: band })).equals(atRest),
  ).toBe(true);
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

    test("scrolled Tempo content is not sliced under the tab bar", async ({ page }) => {
      await expectTempoPaddingClearWhenScrolled(page);
    });

    test("without scroll timelines, scrolled Tempo content is not sliced under the tab bar", async ({ page }) => {
      await expectTempoPaddingClearWhenScrolled(page, { withoutScrollTimeline: true });
    });
  });
}
