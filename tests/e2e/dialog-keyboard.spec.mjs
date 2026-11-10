// Every dialog closes with Esc and gives focus back to what opened it, and the
// library's controls are big enough to hit (#46).

import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio, seedLibrary, stubExportEndpoints, stubFavorites, stubUpdateCheck } from "./helpers.mjs";

const MIN_TARGET_PX = 24;

async function openApp(page, { updateAvailable = false } = {}) {
  await seedLibrary(page);
  await stubFavorites(page);
  await stubExportEndpoints(page);
  await stubUpdateCheck(page, { available: updateAvailable });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(`.cat-item[data-id="${JOB_ID}"]`)).toBeVisible();
}

test.describe("dialogs and Esc", () => {
  test("About opens on Enter, closes on Esc and hands focus back", async ({ page }) => {
    await openApp(page);
    await page.locator("#aboutBtn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#aboutDialog")).toBeVisible();
    await expect(page.locator("#aboutClose")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.locator("#aboutDialog")).toBeHidden();
    await expect(page.locator("#aboutBtn")).toBeFocused();
  });

  test("the release notes close on Esc", async ({ page }) => {
    await openApp(page, { updateAvailable: true });
    await page.locator("#notifBtn").click();
    await page.locator("#notifReleaseCard").click();
    await expect(page.locator("#releaseDialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("#releaseDialog")).toBeHidden();
  });

  test("Settings closes on Esc and hands focus back to its button", async ({ page }) => {
    await openApp(page);
    await page.locator("#settingsBtn").focus();
    await page.keyboard.press("Enter");
    const close = page.locator(".library-editor-close");
    await expect(close).toBeVisible();
    await close.focus();

    await page.keyboard.press("Escape");
    await expect(page.locator(".library-editor")).toHaveCount(0);
    await expect(page.locator("#settingsBtn")).toBeFocused();
  });

  test("Esc in the reset confirmation closes only it, after typing", async ({ page }) => {
    await openApp(page);
    await page.locator("#settingsBtn").click();
    const reset = page.locator(".settings-reset-btn");
    await reset.scrollIntoViewIfNeeded();
    await reset.click();
    const input = page.locator(".reset-confirm-input");
    await expect(input).toBeFocused();
    await input.type("R");

    await page.keyboard.press("Escape");
    await expect(page.locator(".reset-confirm-card")).toHaveCount(0);
    await expect(page.locator(".library-editor")).toBeVisible();
    await expect(reset).toBeFocused();
  });

  test("the folder editor closes on Esc and hands focus back to the folder", async ({ page }) => {
    await openApp(page);
    const head = page.locator('.folder[data-id="f-unsorted"] > .folder-head');
    await head.dblclick();
    await expect(page.locator(".folder-editor-name")).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.locator(".folder-editor")).toHaveCount(0);
    await expect(page.locator('.folder[data-id="f-unsorted"] > .folder-head')).toBeFocused();
  });
});

/** Rendered sizes of every visible match, as "selector WxH" for the ones under the minimum. */
function smallTargets(page, selectors) {
  return page.evaluate(
    ({ list, min }) =>
      list.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
          .filter((el) => el.getClientRects().length)
          .map((el) => el.getBoundingClientRect())
          .filter((box) => box.width < min || box.height < min)
          .map((box) => `${selector} ${Math.round(box.width)}x${Math.round(box.height)}`),
      ),
    { list: selectors, min: MIN_TARGET_PX },
  );
}

test.describe("target sizes", () => {
  test("row, folder, transpose and About buttons are at least 24 px", async ({ page }) => {
    await openApp(page);
    await page.locator(`.cat-item[data-id="${JOB_ID}"]`).hover();
    expect(
      await smallTargets(page, [
        ".cat-item .cat-upnext",
        ".cat-item .cat-more",
        ".cat-item .cat-fav",
        ".cat-item .cat-del",
        "#t-pitch-down",
        "#t-pitch-up",
        "#t-pitch-reset",
      ]),
    ).toEqual([]);

    await page.locator("#aboutBtn").click();
    expect(await smallTargets(page, ["#aboutClose", ".about-social-btn"])).toEqual([]);
  });

  test("a lane's transpose arrows take a 24 px hit, reaching away from the K", async ({ page }) => {
    await openStudio(page);
    const up = page.locator('.lane-key[data-stem="vocals"] .lane-key-step.up');
    await expect(up).toBeVisible();
    const box = await up.boundingBox();
    const hits = await page.evaluate(
      ({ x, ys }) => ys.map((y) => Boolean(document.elementFromPoint(x, y)?.closest(".lane-key-step.up"))),
      { x: box.x + box.width / 2, ys: [box.y + box.height - 1, box.y + box.height - MIN_TARGET_PX + 1] },
    );
    expect(hits).toEqual([true, true]);
  });
});
