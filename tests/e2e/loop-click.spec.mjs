// A click on the waveform seeks; only a drag selects a loop. A click used to
// write the loop fields as "t - t", an empty loop nobody asked for.
import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

// seed.py writes a 6 second fixture.
const LOOP_START = "02.000";
const LOOP_END = "04.000";
const CLICK_FRAC = 0.1;
const DRAG_FROM_FRAC = 0.2;
const DRAG_TO_FRAC = 0.5;
const DRAG_STEPS = 8;
const FIELDS_HINT = "Loop start/end · scroll";

async function armLoop(page) {
  await page.locator("#t-loop-end").fill(LOOP_END);
  await page.locator("#t-loop-end").blur();
  await page.locator("#t-loop-start").fill(LOOP_START);
  await page.locator("#t-loop-start").blur();
  await expect(page.locator("#t-loop")).toHaveClass(/active/);
}

/** A point on the waveform's visible part, once it has finished loading. */
async function waveformPoint(page, frac) {
  await expect(page.locator("#waveLoadingOverlay")).toBeHidden();
  const visible = await page.locator(".wave-scroll").boundingBox();
  const column = await page.locator(".waves-column").boundingBox();
  return { x: visible.x + visible.width * frac, y: column.y + column.height / 2 };
}

const loopFields = async (page) => [
  await page.locator("#t-loop-start").inputValue(),
  await page.locator("#t-loop-end").inputValue(),
];

test.describe("waveform click and the loop", () => {
  test("a click keeps the loop bounds it had", async ({ page }) => {
    await openStudio(page);
    await armLoop(page);

    const { x, y } = await waveformPoint(page, CLICK_FRAC);
    await page.mouse.click(x, y);

    expect(await loopFields(page)).toEqual([LOOP_START, LOOP_END]);
  });

  test("a drag still selects a loop", async ({ page }) => {
    await openStudio(page);

    const from = await waveformPoint(page, DRAG_FROM_FRAC);
    const to = await waveformPoint(page, DRAG_TO_FRAC);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: DRAG_STEPS });
    await page.mouse.up();

    await expect(page.locator("#t-loop")).toHaveClass(/active/);
    const [start, end] = await loopFields(page);
    expect(start).not.toEqual(end);
  });

  test("the loop fields' label names them and says how to adjust", async ({ page }) => {
    await openStudio(page);

    await expect(page.locator(".footer-loop-hint")).toHaveText(FIELDS_HINT);
  });
});
