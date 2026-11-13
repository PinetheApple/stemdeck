// Keyboard focus in the import queue survives a redraw of the list: it stays on
// the same row's control, or moves to the next row's when that row has gone.

import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  LONG_QUEUE_WAITING_IDS,
  seedLibrary,
  stubFavorites,
  stubLongQueue,
  stubUpdateCheck,
  tabTo,
} from "./helpers.mjs";

const [FIRST_WAITING, SECOND_WAITING, THIRD_WAITING] = LONG_QUEUE_WAITING_IDS;
const NEW_WAITING = "e2e0feed0004";
const OTHER_LANGUAGE = "de";
const CANCEL = ".queue-cancel";
const EXTRACT_NEXT = ".queue-top";

async function openQueue(page) {
  await seedLibrary(page);
  await stubFavorites(page);
  await stubUpdateCheck(page);
  const queue = await stubLongQueue(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`.cat-item[data-id="${JOB_ID}"]`)).toBeVisible();
  await page.evaluate(() => import("/js/queue.js").then((m) => m.refreshQueue()));
  await page.locator(".rail-queue").click();
  await expect(page.locator(EXTRACT_NEXT).first()).toBeAttached();
  return queue;
}

/** Tab to a row's control and tag it, so a test can tell a rebuilt one from it. */
async function focusByKeyboard(page, jobId, control) {
  const selector = `.queue-row[data-id="${jobId}"] ${control}`;
  await tabTo(page, selector);
  await page.locator(selector).evaluate((el) => {
    el.dataset.beforeRedraw = "1";
  });
  return selector;
}

async function expectRebuiltAndFocused(page, selector) {
  const focused = page.locator(selector);
  await expect(focused).toBeFocused();
  await expect(focused).not.toHaveAttribute("data-before-redraw");
  expect(await focused.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
}

test.describe("import queue focus across redraws", () => {
  test("a queue change keeps focus on the same row's extract-next button", async ({ page }) => {
    const queue = await openQueue(page);
    const selector = await focusByKeyboard(page, THIRD_WAITING, EXTRACT_NEXT);

    await queue.setWaiting([...LONG_QUEUE_WAITING_IDS, NEW_WAITING]);

    await expectRebuiltAndFocused(page, selector);
  });

  test("a library redraw keeps focus on the same row's cancel button", async ({ page }) => {
    await openQueue(page);
    const selector = await focusByKeyboard(page, SECOND_WAITING, CANCEL);

    await page.evaluate((code) => import("/js/i18n.js").then((m) => m.setLanguage(code)), OTHER_LANGUAGE);

    await expectRebuiltAndFocused(page, selector);
  });

  test("when the focused row leaves the queue, focus moves to the next row's cancel", async ({ page }) => {
    const queue = await openQueue(page);
    await focusByKeyboard(page, FIRST_WAITING, CANCEL);

    await queue.setWaiting([SECOND_WAITING, THIRD_WAITING]);

    await expect(page.locator(`.queue-row[data-id="${FIRST_WAITING}"]`)).toHaveCount(0);
    await expectRebuiltAndFocused(page, `.queue-row[data-id="${SECOND_WAITING}"] ${CANCEL}`);
  });
});
