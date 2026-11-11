// The count-in plays with the click track off as well as on, so the Tempo tab
// says so in a small muted caption under the Count-in select.
import { test, expect } from "@playwright/test";
import { openStudio, waitForClickTrack } from "./helpers.mjs";

const CAPTIONS = {
  en: "Plays even with the click track off",
  de: "Klingt auch bei ausgeschaltetem Click-Track",
};
const WIDTHS = [1024, 1440];
const HEIGHT = 800;
const SUBPIXEL = 1;

async function useLanguage(page, code) {
  await page.addInitScript(
    (lang) => window.localStorage.setItem("stemdeck.language", JSON.stringify(lang)),
    code,
  );
}

function measureCaption() {
  const hint = document.querySelector("#inspectorPaneTempo .metro-countin-hint");
  const select = document.querySelector("#t-metro-countin");
  const pane = document.querySelector("#inspectorPaneTempo");
  const hintStyle = getComputedStyle(hint);
  const selectStyle = getComputedStyle(select);
  const h = hint.getBoundingClientRect();
  const s = select.getBoundingClientRect();
  const p = pane.getBoundingClientRect();
  return {
    hintSize: parseFloat(hintStyle.fontSize),
    selectSize: parseFloat(selectStyle.fontSize),
    hintColor: hintStyle.color,
    selectColor: selectStyle.color,
    below: h.top >= s.bottom - 1,
    alignedLeft: Math.abs(h.left - s.left),
    insidePane: h.left >= p.left && h.right <= p.right,
    clippedX: hint.scrollWidth - hint.clientWidth,
    clippedY: hint.scrollHeight - hint.clientHeight,
    paneOverflowX: pane.scrollWidth - pane.clientWidth,
  };
}

test.describe("count-in caption in the Tempo tab", () => {
  for (const [lang, caption] of Object.entries(CAPTIONS)) {
    for (const width of WIDTHS) {
      test(`${lang} at ${width}px: a muted line under Count-in`, async ({ page }) => {
        await useLanguage(page, lang);
        await page.setViewportSize({ width, height: HEIGHT });
        await openStudio(page, { tauri: true });
        await waitForClickTrack(page);

        const hint = page.locator("#inspectorPaneTempo .metro-countin-hint");
        await expect(hint).toBeVisible();
        await expect(hint).toHaveText(caption);

        const m = await page.evaluate(measureCaption);
        expect(m.below, "under the Count-in select").toBe(true);
        expect(m.alignedLeft, "starts where the select starts").toBeLessThanOrEqual(SUBPIXEL);
        expect(m.hintSize, "smaller than the select's label").toBeLessThan(m.selectSize);
        expect(m.hintColor, "a quieter colour than the select's label").not.toBe(m.selectColor);
        expect(m.insidePane, "inside the Tempo tab").toBe(true);
        expect(m.clippedX, "not cut off sideways").toBeLessThanOrEqual(0);
        expect(m.clippedY, "not cut off vertically").toBeLessThanOrEqual(0);
        expect(m.paneOverflowX, "the Tempo tab does not scroll sideways").toBeLessThanOrEqual(0);
        await page.locator("#t-metro-edit").scrollIntoViewIfNeeded();
        await expect(page.locator("#t-metro-edit")).toBeInViewport();
      });
    }
  }

  test("the Tempo tab's caption is the only one on the page", async ({ page }) => {
    await page.setViewportSize({ width: WIDTHS[1], height: HEIGHT });
    await openStudio(page, { tauri: true });
    await waitForClickTrack(page);

    await expect(page.locator(".metro-countin-hint")).toHaveCount(1);
    await expect(page.locator(".daw-footer .metro-countin-hint")).toHaveCount(0);
  });
});
