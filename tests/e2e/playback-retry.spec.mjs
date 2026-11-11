// A playback error offers Try again, which reloads the open song's audio in
// place.
import { test, expect } from "@playwright/test";
import { openStudio } from "./helpers.mjs";

const STEMS = "**/stems/*.wav";
const SERVER_ERROR = 500;

/** Fail every stem download while `broken` is set, counting the failures. */
async function breakStems(page) {
  const stems = { broken: true, failures: 0 };
  await page.route(STEMS, async function answerStem(route) {
    if (!stems.broken) return route.continue();
    stems.failures += 1;
    return route.fulfill({ status: SERVER_ERROR, body: "" });
  });
  return stems;
}

const engineUp = (page) =>
  page.evaluate(async () => Boolean((await import("/js/state.js")).audioEngine));

test.describe("playback error retry", () => {
  test("Try again reloads the audio and the song plays", async ({ page }) => {
    const stems = await breakStems(page);
    await openStudio(page);
    const box = page.locator("#error");
    await expect(box).toBeVisible();
    expect(await engineUp(page)).toBe(false);

    stems.broken = false;
    await box.locator(".retry-btn").click();

    await expect(box).toBeHidden();
    await expect.poll(() => engineUp(page)).toBe(true);
    await page.locator("#t-play").click();
    await expect(page.locator("#t-play")).toHaveClass(/playing/);
  });

  test("Try again shows the error again while the audio still fails", async ({ page }) => {
    const stems = await breakStems(page);
    await openStudio(page);
    const box = page.locator("#error");
    await expect(box.locator(".retry-btn")).toBeVisible();
    const failuresBefore = stems.failures;

    await box.locator(".retry-btn").click();

    await expect.poll(() => stems.failures).toBeGreaterThan(failuresBefore);
    await expect(box.locator(".retry-btn")).toBeVisible();
    expect(await engineUp(page)).toBe(false);
  });
});
