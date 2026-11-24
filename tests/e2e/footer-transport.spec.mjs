// The footer: what is playing on the left, the transport over a seek bar in the
// middle, Record and the practice controls on the right, on one row.

import { test, expect } from "@playwright/test";
import { JOB_ID, TRACK_TITLE, exportUi, openLoopOptions, openStudio } from "./helpers.mjs";
import { openSiblingOverPlaying } from "./openVsPlaying.mjs";

const NARROW = { width: 1366, height: 768 };
const WIDE = { width: 1920, height: 1080 };
const ZONES = [".ft-now:not([hidden])", ".ft-transport", ".ft-right"];
const ROW_TOLERANCE_PX = 2;
const SEEK_TO_SEC = 4;
const RESTART_SLACK_SEC = 0.5;
const SECTIONS = [
  { id: "s1", start: 0, end: 20, kind: "verse" },
  { id: "s2", start: 20, end: 40, kind: "chorus" },
];

const zoneBoxes = (page) => page.evaluate(
  (selectors) => selectors.map((s) => document.querySelector(s).getBoundingClientRect().toJSON()),
  ZONES,
);
const clock = (page) => page.evaluate(async () => (await import("/js/transport.js")).transport().getCurrentTime());

async function expectOneRow(page) {
  const boxes = await zoneBoxes(page);
  const centres = boxes.map((b) => b.top + b.height / 2);
  for (const c of centres) expect(Math.abs(c - centres[0])).toBeLessThanOrEqual(ROW_TOLERANCE_PX);
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right);
  const viewport = page.viewportSize();
  const overflow = await page.evaluate(() => [...document.querySelectorAll("#footer button, #footer input")]
    .filter((el) => el.getClientRects().length)
    .some((el) => el.getBoundingClientRect().right > window.innerWidth));
  expect(overflow).toBe(false);
  expect(boxes.every((b) => b.right <= viewport.width)).toBe(true);
}

test("at 1920 px the footer is one row and Record shows its label", async ({ page }) => {
  await page.setViewportSize(WIDE);
  await openStudio(page);
  await expectOneRow(page);
  await expect(page.locator("#t-rec .rec-btn-label")).toBeVisible();
});

test("at 1366 px the footer stays on one row and Record collapses to its dot", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await openStudio(page);
  await expectOneRow(page);
  await expect(page.locator("#t-rec .rec-btn-label")).toBeHidden();
  await expect(page.locator("#t-rec .rec-btn-dot")).toBeVisible();
});

test("coral marks only Play and the controls that are on", async ({ page }) => {
  await openStudio(page);
  await page.locator("#t-loop").click();
  const stray = await page.evaluate(() => {
    const coralOf = (token) => {
      const probe = document.createElement("i");
      probe.style.color = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const corals = ["--accent", "--accent-hi", "--accent-soft"].map(coralOf);
    const allowed = (el) => el.closest("#t-play, [aria-pressed='true'], .is-on");
    const props = ["color", "backgroundColor", "borderTopColor", "outlineColor"];
    return [...document.querySelectorAll("#footer *")]
      .filter((el) => el.getClientRects().length && !allowed(el))
      .filter((el) => props.some((p) => corals.includes(getComputedStyle(el)[p])))
      .map((el) => el.id || el.className);
  });
  expect(stray).toEqual([]);
  await expect(page.locator("#t-loop")).toHaveAttribute("aria-pressed", "true");
});

test("the left shows the playing song with its current and next section", async ({ page }) => {
  await openStudio(page);
  await expect(page.locator("#footerNowTitle")).toHaveText(TRACK_TITLE);
  await expect(page.locator(".ft-now-playing")).toBeHidden();
  await expect(page.locator("#footerNow")).toBeVisible();
  await expect(page.locator("#footerPlayingTitle")).toBeHidden();
  await page.evaluate(async ({ id, sections }) => {
    (await import("/js/sections.js")).initSections(id, sections, 60);
  }, { id: JOB_ID, sections: SECTIONS });
  await expect(page.locator("#footerNowSections")).toHaveText("Verse · next Chorus");
});

test("while another song is shown the left is marked Playing", async ({ page }) => {
  await openSiblingOverPlaying(page);
  await expect(page.locator(".ft-now-playing")).toBeVisible();
  await expect(page.locator("#footerPlayingTitle #footerNowTitle")).toHaveText(TRACK_TITLE);
  await expect(page.locator("#footerNow")).toBeHidden();
});

test("Previous goes back to the start of the song", async ({ page }) => {
  await openStudio(page);
  await page.evaluate(async (sec) => (await import("/js/transport.js")).setPlayheadTime(sec), SEEK_TO_SEC);
  await expect.poll(() => clock(page)).toBeGreaterThan(SEEK_TO_SEC - RESTART_SLACK_SEC);
  await page.locator("#t-prev").click();
  await expect.poll(() => clock(page)).toBeLessThan(RESTART_SLACK_SEC);
});

test("the Up Next button shows Up Next in the song tools", async ({ page }) => {
  await openStudio(page);
  const button = page.locator("#t-upnext");
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await button.click();
  await expect(page.locator('.inspector-pane[data-pane="upnext"]')).toBeVisible();
  await expect(button).toHaveAttribute("aria-pressed", "true");
});

test("Export sits in the song header and opens its menu below it, inside the window", async ({ page }) => {
  await page.setViewportSize(NARROW);
  await openStudio(page);
  const ui = exportUi(page);
  await expect(page.locator("#songHead #t-export-btn")).toBeVisible();
  await expect(ui.button).toHaveAccessibleName("Export Mix");
  const titleFits = () => page.locator("#title").evaluate((el) => el.scrollWidth <= el.clientWidth);
  await expect.poll(titleFits).toBe(true);
  await expect(page.locator("#footer #t-export-btn")).toHaveCount(0);
  await ui.open();
  const [button, panel] = await Promise.all([ui.button.boundingBox(), ui.panel.boundingBox()]);
  expect(panel.y).toBeGreaterThanOrEqual(button.y + button.height);
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(NARROW.width);
  expect(panel.y + panel.height).toBeLessThanOrEqual(NARROW.height);
  for (const row of ["#t-export-mix", "#t-export-stems", "#t-export-bundle", "#t-export-region", "#t-export-click", "#t-export-count-in", "#t-export-master"]) {
    await expect(page.locator(row)).toBeAttached();
  }
  await expect(ui.mix).toBeVisible();
});

test("opening a footer popover closes the Export menu, and opening Export closes the popover", async ({ page }) => {
  await openStudio(page);
  const ui = exportUi(page);
  await ui.open();
  await openLoopOptions(page);
  await expect(ui.panel).toBeHidden();
  await ui.button.click();
  await expect(ui.panel).toBeVisible();
  await expect(page.locator("#t-loop-panel")).toBeHidden();
});
