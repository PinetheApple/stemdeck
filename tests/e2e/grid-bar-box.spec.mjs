import { test, expect } from "@playwright/test";
import { openStudio, waitForClickTrack } from "./helpers.mjs";

const ONE_DIGIT = "4";
const TWO_DIGITS = "32";
const THREE_DIGITS = "100";
const MAX_BAR_LENGTH = "32";

async function openGrid(page) {
  await openStudio(page, { tauri: true });
  await waitForClickTrack(page);
  await page.locator("#t-metro-edit").click();
  await expect(page.locator("#beatgrid-toolbar")).not.toHaveClass(/hidden/);
}

async function expectNotClipped(input, label) {
  const { scrollWidth, clientWidth } = await input.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth, label).toBeLessThanOrEqual(clientWidth);
}

test("the Bar box shows one- and two-digit values in full", async ({ page }) => {
  await openGrid(page);
  const input = page.locator("#bg-barlen");

  for (const value of [ONE_DIGIT, TWO_DIGITS]) {
    await input.fill(value);
    await input.press("Enter");
    await expect(input).toHaveValue(value);
    await page.mouse.move(0, 0);
    await expectNotClipped(input, `${value} fits`);
    await input.hover();
    await expectNotClipped(input, `${value} fits while hovered`);
  }
});

test("a three-digit Bar entry settles on the longest value, in full", async ({ page }) => {
  await openGrid(page);
  const input = page.locator("#bg-barlen");

  await input.fill(THREE_DIGITS);
  await input.press("Enter");
  await expect(input).toHaveValue(MAX_BAR_LENGTH);
  await expectNotClipped(input, `${THREE_DIGITS} settles as ${MAX_BAR_LENGTH} and fits`);
});
