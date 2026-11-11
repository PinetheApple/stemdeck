// Every dialog closes with Esc and gives focus back to what opened it, and the
// library's controls are big enough to hit.

import { test, expect } from "@playwright/test";
import {
  JOB_ID,
  KEY,
  SIBLING_JOB_ID,
  fixtureTrack,
  openStudio,
  seedCatalogState,
  seedLibrary,
  stubExportEndpoints,
  stubFavorites,
  stubLongQueue,
  stubUpdateCheck,
} from "./helpers.mjs";

const MIN_TARGET_PX = 24;

async function openApp(page, { updateAvailable = false, seed = seedLibrary } = {}) {
  await seed(page);
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
    await page.keyboard.press(KEY.ENTER);
    await expect(page.locator("#aboutDialog")).toBeVisible();
    await expect(page.locator("#aboutClose")).toBeFocused();

    await page.keyboard.press(KEY.ESCAPE);
    await expect(page.locator("#aboutDialog")).toBeHidden();
    await expect(page.locator("#aboutBtn")).toBeFocused();
  });

  test("the release notes close on Esc", async ({ page }) => {
    await openApp(page, { updateAvailable: true });
    await page.locator("#notifBtn").click();
    await page.locator("#notifReleaseCard").click();
    await expect(page.locator("#releaseDialog")).toBeVisible();

    await page.keyboard.press(KEY.ESCAPE);
    await expect(page.locator("#releaseDialog")).toBeHidden();
  });

  test("Settings closes on Esc and hands focus back to its button", async ({ page }) => {
    await openApp(page);
    await page.locator("#settingsBtn").focus();
    await page.keyboard.press(KEY.ENTER);
    const close = page.locator(".library-editor-close");
    await expect(close).toBeVisible();
    await close.focus();

    await page.keyboard.press(KEY.ESCAPE);
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

    await page.keyboard.press(KEY.ESCAPE);
    await expect(page.locator(".reset-confirm-card")).toHaveCount(0);
    await expect(page.locator(".library-editor")).toBeVisible();
    await expect(reset).toBeFocused();
  });

  test("the folder editor closes on Esc and hands focus back to the folder", async ({ page }) => {
    await openApp(page);
    const head = page.locator('.folder[data-id="f-unsorted"] > .folder-head');
    await head.dblclick();
    await expect(page.locator(".folder-editor-name")).toBeFocused();

    await page.keyboard.press(KEY.ESCAPE);
    await expect(page.locator(".folder-editor")).toHaveCount(0);
    await expect(page.locator('.folder[data-id="f-unsorted"] > .folder-head')).toBeFocused();
  });
});

const PLAYLIST_URL = "https://www.youtube.com/playlist?list=PLkeyboardnav";
const PLAYLIST_PREVIEW = {
  playlist_title: "Keys",
  will_queue: 2,
  total_found: 2,
  skipped_unavailable: 0,
  skipped_too_long: 0,
  truncated: false,
  cap: 50,
  capacity_left: 10,
};

async function openPlaylistConfirm(page) {
  const url = page.locator("#url");
  await url.fill(PLAYLIST_URL);
  await url.press(KEY.ENTER);
  await expect(page.locator(".playlist-confirm")).toBeVisible();
}

test.describe("more dialogs and Esc", () => {
  test("a failure's details close on Esc and hand focus back to its card", async ({ page }) => {
    await openApp(page);
    await page.evaluate(() =>
      import("/js/notifications.js").then((m) => m.notifyFailure({ kind: "export", message: "disk full" })),
    );
    await page.locator("#notifBtn").click();
    const card = page.locator(".daw-notif-error").first();
    await card.focus();
    await page.keyboard.press(KEY.ENTER);
    await expect(page.locator("#failureDialog")).toBeVisible();
    await expect(page.locator("#failureClose")).toBeFocused();

    await page.keyboard.press(KEY.ESCAPE);
    await expect(page.locator("#failureDialog")).toBeHidden();
    await expect(card).toBeFocused();
  });

  test("the playlist confirmation hands focus back on Esc, Cancel and Import", async ({ page }) => {
    await page.route("**/api/playlist/preview", (route) => route.fulfill({ json: PLAYLIST_PREVIEW }));
    await page.route(
      "**/api/playlist",
      (route) => route.fulfill({ json: { playlist_title: "Keys", jobs: [], queued: 0 } }),
    );
    await openApp(page);

    await openPlaylistConfirm(page);
    await page.keyboard.press(KEY.ESCAPE);
    await expect(page.locator(".playlist-confirm")).toHaveCount(0);
    await expect(page.locator("#url")).toBeFocused();

    for (const button of [".reset-confirm-cancel", ".playlist-confirm-go"]) {
      await openPlaylistConfirm(page);
      await page.locator(`.playlist-confirm ${button}`).click();
      await expect(page.locator(".playlist-confirm")).toHaveCount(0);
      await expect(page.locator("#url")).toBeFocused();
    }
  });
});

/** Selectors with nothing on screen, and "selector WxH" for each match under the minimum. */
function smallTargets(page, selectors) {
  return page.evaluate(
    ({ list, min }) => {
      const shown = (selector) => [...document.querySelectorAll(selector)].filter((el) => el.getClientRects().length);
      return {
        missing: list.filter((selector) => !shown(selector).length),
        small: list.flatMap((selector) =>
          shown(selector)
            .map((el) => el.getBoundingClientRect())
            .filter((box) => box.width < min || box.height < min)
            .map((box) => `${selector} ${Math.round(box.width)}x${Math.round(box.height)}`),
        ),
      };
    },
    { list: selectors, min: MIN_TARGET_PX },
  );
}

const ALL_TARGETS_MET = { missing: [], small: [] };
/** A user folder, for its head's buttons, and a stopped song, for its Extract button. */
function seedFolderAndStoppedSong(page) {
  return seedCatalogState(page, {
    folders: [
      { id: "f-unsorted", name: "Unsorted", items: [JOB_ID], color: null },
      { id: "f-live", name: "Live", items: [SIBLING_JOB_ID], color: null },
      { id: "trash", name: "Trash", items: [], color: null },
    ],
    tracks: {
      [JOB_ID]: { ...fixtureTrack(JOB_ID, JOB_ID), status: "stopped" },
      [SIBLING_JOB_ID]: fixtureTrack(SIBLING_JOB_ID, SIBLING_JOB_ID),
    },
  });
}

test.describe("target sizes", () => {
  test("row, folder, transpose and About buttons are at least 24 px", async ({ page }) => {
    await openApp(page, { seed: seedFolderAndStoppedSong });
    await page.locator(`.cat-item[data-id="${SIBLING_JOB_ID}"]`).hover();
    await expect(page.locator(".cat-item .cat-extract")).toBeVisible();
    expect(
      await smallTargets(page, [
        "#newFolderBtn",
        ".folder-head .f-subfolder",
        ".folder-head .f-del",
        ".cat-item .cat-extract",
        ".cat-item .cat-upnext",
        ".cat-item .cat-more",
        ".cat-item .cat-fav",
        ".cat-item .cat-del",
        "#t-pitch-down",
        "#t-pitch-up",
        "#t-pitch-reset",
      ]),
    ).toEqual(ALL_TARGETS_MET);

    await page.locator("#aboutBtn").click();
    expect(await smallTargets(page, ["#aboutClose", ".about-social-btn"])).toEqual(ALL_TARGETS_MET);
  });

  test("an import's cancel and extract-next buttons are at least 24 px", async ({ page }) => {
    await stubLongQueue(page);
    await openApp(page);
    await page.evaluate(() => import("/js/queue.js").then((m) => m.refreshQueue()));
    await page.locator(".rail-queue").click();
    await expect(page.locator(".queue-top").first()).toBeAttached();
    expect(await smallTargets(page, [".queue-cancel", ".queue-top"])).toEqual(ALL_TARGETS_MET);
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

test.describe("import queue by keyboard", () => {
  const TAB_LIMIT = 60;
  const SHOWN = "1";

  async function tabTo(page, selector) {
    for (let press = 0; press < TAB_LIMIT; press++) {
      await page.keyboard.press(KEY.TAB);
      if (await page.evaluate((s) => document.activeElement?.matches(s), selector)) return;
    }
    throw new Error(`Tab never reached ${selector}`);
  }

  const focusedOpacity = (page) => page.evaluate(() => getComputedStyle(document.activeElement).opacity);

  test("an import's cancel and extract-next buttons show when Tab lands on them", async ({ page }) => {
    await stubLongQueue(page);
    await openApp(page);
    await page.evaluate(() => import("/js/queue.js").then((m) => m.refreshQueue()));
    await page.locator(".rail-queue").click();
    await expect(page.locator(".queue-top").first()).toBeAttached();
    await page.mouse.move(0, 0);
    for (const selector of [".queue-cancel", ".queue-top"]) {
      await tabTo(page, selector);
      await expect.poll(() => focusedOpacity(page), { message: selector }).toBe(SHOWN);
    }
  });
});
