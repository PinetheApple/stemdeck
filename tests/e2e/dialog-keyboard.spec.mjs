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
  tabTo,
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

async function openLongQueue(page) {
  await stubLongQueue(page);
  await openApp(page);
  await page.evaluate(() => import("/js/queue.js").then((m) => m.refreshQueue()));
  await page.locator(".rail-queue").click();
  await expect(page.locator(".queue-top").first()).toBeAttached();
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
const PLAYLIST_TRACK = (n) => ({
  input: PLAYLIST_URL, line: 1, url: `https://www.youtube.com/watch?v=keys${n}aaaaaa`, title: `Key ${n}`, artist: null,
  duration_sec: 200, status: "ok", existing_job_id: null, replaces: null,
  playlist: { url: PLAYLIST_URL, title: "Keys", index: n },
});
const PLAYLIST_PREVIEW = {
  items: [PLAYLIST_TRACK(1), PLAYLIST_TRACK(2)],
  playlists: [{ input: PLAYLIST_URL, line: 1, url: PLAYLIST_URL, title: "Keys", found: 2, unavailable: 0, truncated: false }],
  files: [],
  max_duration_sec: 1200,
  capacity_left: { links: 10, files: 10 },
};

async function openPlaylistReview(page) {
  const url = page.locator("#url");
  await url.fill(PLAYLIST_URL);
  await url.press(KEY.ENTER);
  await expect(page.locator("#batchReview .batch-queue")).toBeEnabled();
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

  test("a playlist's review hands focus back on Esc, Cancel and Queue", async ({ page }) => {
    await openApp(page);
    await page.route("**/api/import/preview", (route) => route.fulfill({ json: PLAYLIST_PREVIEW }));
    const created = [];
    await page.route(/\/api\/jobs$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      created.push(route.request().postDataJSON().url);
      return route.fulfill({ json: { job_id: `e2e0ce11000${created.length}` } });
    });

    for (const close of [() => page.keyboard.press(KEY.ESCAPE), () => page.locator("#batchReview .batch-cancel").click()]) {
      await openPlaylistReview(page);
      await close();
      await expect(page.locator("#batchReview")).toHaveCount(0);
      await expect(page.locator("#url")).toBeFocused();
      await page.locator("#url").fill("");
    }

    await openPlaylistReview(page);
    await page.locator("#batchReview .batch-queue").click();
    await expect(page.locator("#batchReview")).toHaveCount(0);
    await expect(page.locator("#url")).toBeFocused();
    expect(created).toHaveLength(PLAYLIST_PREVIEW.items.length);
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
    await openLongQueue(page);
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
  const SHOWN = "1";
  // Opacity of the unfocused extract-next button inside a row that has keyboard focus.
  const SIBLING_IN_FOCUSED_ROW = "0.65";
  const CANCEL_RESTING = "0.65";
  const EXTRACT_RESTING = "0";

  const FOCUSED_ROW = ".queue-row:has(:focus)";
  const focused = (page) => page.locator(":focus");
  const focusedRow = (page, selector) => page.locator(`${FOCUSED_ROW} ${selector}`);
  const focusedRowId = (page) => page.locator(FOCUSED_ROW).getAttribute("data-id");
  // A read mid-fade can already show the expected value, so wait the fade out.
  const opacity = (locator) =>
    locator.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((fade) => fade.finished));
      return getComputedStyle(el).opacity;
    });

  test("an import's cancel and extract-next buttons show when Tab lands on them", async ({ page }) => {
    await openLongQueue(page);
    await page.mouse.move(0, 0);

    await tabTo(page, ".queue-top");
    await expect.poll(() => opacity(focused(page))).toBe(SHOWN);
    await expect.poll(() => opacity(focusedRow(page, ".queue-cancel"))).toBe(SHOWN);

    const extractRow = await focusedRowId(page);
    await tabTo(page, ".queue-cancel");
    expect(await focusedRowId(page)).toBe(extractRow);
    await expect.poll(() => opacity(focused(page))).toBe(SHOWN);
    await expect.poll(() => opacity(focusedRow(page, ".queue-top"))).toBe(SIBLING_IN_FOCUSED_ROW);
  });

  test("a mouse click leaves an import's buttons at rest once the pointer moves away", async ({ page }) => {
    await openLongQueue(page);
    const row = page.locator(".queue-row:has(.queue-top)").first();
    // The real handler disables the button first, which drops its focus, then reorders.
    await page.evaluate(() => {
      function swallowClick(e) {
        e.stopPropagation();
      }
      document.addEventListener("click", swallowClick, { capture: true, once: true });
    });
    await row.locator(".queue-top").click();
    await expect(row.locator(".queue-top")).toBeFocused();
    await page.mouse.move(0, 0);

    await expect.poll(() => opacity(row.locator(".queue-top"))).toBe(EXTRACT_RESTING);
    await expect.poll(() => opacity(row.locator(".queue-cancel"))).toBe(CANCEL_RESTING);
  });
});
