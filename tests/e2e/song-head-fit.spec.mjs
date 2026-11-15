// The song head keeps the open song's title readable with the library and the
// inspector both open, and its buttons whole and apart, from 1024 up.
import { test, expect } from "@playwright/test";
import { JOB_ID, TRACK_TITLE, openStudio, waitForPanesSettled } from "./helpers.mjs";
import { DEFAULT_VERSION_ID } from "../../static/js/versionModel.js";

const NARROW_WINDOW = { width: 1024, height: 768 };
const ROOMY_WINDOWS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];
// Enough of the title to tell the song apart: about seven characters at the narrow title size.
const MIN_TITLE_WIDTH = 80;
const SECOND_VERSION = { name: "Practice take", stems: ["vocals", "drums"], open: false };
const COLLAPSED_CLASS = /cat-collapsed/;
// Sub-pixel layout puts edges a fraction past each other even when they fit.
const EDGE_SLACK = 0.5;

const versionsUrl = (id) => `/api/jobs/${id}/versions`;

test.afterEach(async ({ request }) => {
  const { versions } = await (await request.get(versionsUrl(JOB_ID))).json();
  for (const v of versions.filter((x) => x.id !== DEFAULT_VERSION_ID)) {
    await request.delete(`${versionsUrl(JOB_ID)}/${v.id}`);
  }
});

// The click makes the open library the user's choice, so a narrow window leaves it open.
async function openBothPanes(page, size) {
  await page.setViewportSize(size);
  await openStudio(page, { tauri: true });
  await waitForPanesSettled(page);
  const app = page.locator(".app");
  if (COLLAPSED_CLASS.test(await app.getAttribute("class"))) {
    await page.locator("#sidebarCollapseBtn").click();
  }
  await expect(app).not.toHaveClass(COLLAPSED_CLASS);
  await expect(page.locator("#inspector")).toBeVisible();
  await expect(page.locator("#title")).toHaveText(TRACK_TITLE);
  await waitForPanesSettled(page);
}

// The title's width left showing inside the card, which clips what overflows it.
const shownTitleWidth = (page) =>
  page.evaluate(() => {
    const title = document.querySelector("#title").getBoundingClientRect();
    const card = document.querySelector("#nowPlayingPanel").getBoundingClientRect();
    return Math.max(0, Math.min(title.right, card.right) - Math.max(title.left, card.left));
  });

const titleCut = (page) =>
  page.locator("#title").evaluate((el) => el.scrollWidth > el.clientWidth);

// Ids of head buttons that are squeezed, outside the head, or on top of another one.
const misfitButtons = (page) =>
  page.evaluate((slack) => {
    const head = document.querySelector("#songHead").getBoundingClientRect();
    const buttons = [...document.querySelectorAll("#songHead button")]
      .filter((el) => el.checkVisibility() && el.id !== "npVersionBtn")
      .map((el) => ({ id: el.id || el.className, el, box: el.getBoundingClientRect() }));
    const squeezed = ({ el }) => el.scrollWidth > el.clientWidth + slack;
    const outside = ({ box }) => box.left < head.left - slack || box.right > head.right + slack;
    const overlaps = (a) =>
      buttons.some((b) => b !== a && a.box.left < b.box.right - slack && b.box.left < a.box.right - slack);
    return buttons.filter((b) => squeezed(b) || outside(b) || overlaps(b)).map((b) => b.id);
  }, EDGE_SLACK);

test.describe("song head with the library and the inspector open", () => {
  test(`at ${NARROW_WINDOW.width} the title shows and the buttons fit`, async ({ page }) => {
    await openBothPanes(page, NARROW_WINDOW);

    await expect.poll(() => shownTitleWidth(page)).toBeGreaterThanOrEqual(MIN_TITLE_WIDTH);
    expect(await misfitButtons(page)).toEqual([]);
  });

  test(`at ${NARROW_WINDOW.width} the version label gives way to the title`, async ({ page, request }) => {
    const res = await request.post(versionsUrl(JOB_ID), { data: SECOND_VERSION });
    expect(res.status()).toBe(201);
    await openBothPanes(page, NARROW_WINDOW);
    await expect(page.locator("#npVersionBtn")).toBeVisible();

    await expect.poll(() => shownTitleWidth(page)).toBeGreaterThanOrEqual(MIN_TITLE_WIDTH);
    expect(await misfitButtons(page)).toEqual([]);
  });

  for (const size of ROOMY_WINDOWS) {
    test(`at ${size.width} the whole title shows`, async ({ page }) => {
      await openBothPanes(page, size);

      expect(await titleCut(page)).toBe(false);
      expect(await shownTitleWidth(page)).toBeGreaterThan(MIN_TITLE_WIDTH);
      expect(await misfitButtons(page)).toEqual([]);
    });
  }
});
