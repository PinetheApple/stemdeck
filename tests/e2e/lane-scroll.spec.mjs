// The waveform pane can carry a horizontal scrollbar that the mixer column does
// not: below a 720px pane width the waveform keeps that width and scrolls, and
// zooming in widens it too. Unless the lanes allow for that bar, the waveform
// pane shows less than the mixer, so the last lane cannot be scrolled fully into
// view beside its mixer row, or a stack that fits the mixer overflows the
// waveforms (#206).

import { test, expect } from "@playwright/test";
import { JOB_ID, openStudio } from "./helpers.mjs";

const SHORT_WINDOW = { width: 1024, height: 768 };
const TALL_WINDOW = { width: 1440, height: 1100 };
const ADDED_STEMS = ["guitar", "piano"];
const SOURCE_STEM = "bass";
const STEM_COUNT = 6;
const WHEEL_STEP_PX = 400;
const WHEEL_STEPS = 6;
const ZOOM_IN_DELTA = -240;
const ZOOM_IN_STEPS = 4;
const SETTLE_MS = 450;
const ALIGN_TOLERANCE_PX = 2;

// Headless Chromium hides scrollbars by default; the bar this is about must exist.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

/** Serve the four-stem fixture as a six-stem song: the extra stems reuse the bass audio. */
async function serveSixStems(page) {
  await page.route(`**/api/jobs/${JOB_ID}`, async function addStemsToJob(route) {
    const response = await route.fetch();
    const job = await response.json();
    const source = job.stems.find((stem) => stem.name === SOURCE_STEM);
    for (const name of ADDED_STEMS) job.stems.push({ ...source, name });
    await route.fulfill({ response, json: job });
  });
  await page.route(`**/api/jobs/${JOB_ID}/peaks`, async function addStemsToPeaks(route) {
    const response = await route.fetch();
    const peaks = await response.json();
    for (const name of ADDED_STEMS) peaks[name] = peaks[SOURCE_STEM];
    await route.fulfill({ response, json: peaks });
  });
}

async function openSixStemStudio(page, viewport) {
  await page.setViewportSize(viewport);
  await serveSixStems(page);
  await openStudio(page);
  const playableRows = page.locator(".mixer-column .lane-header:not(.hidden):not(.unavailable)");
  await expect(playableRows).toHaveCount(STEM_COUNT);
  await page.waitForTimeout(SETTLE_MS);
}

/** Row and lane edges, and the bottom of the part of each column that is actually shown. */
function laneGeometry(page) {
  return page.evaluate(() => {
    const edges = (selector) => [...document.querySelectorAll(selector)].map((el) => {
      const box = el.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    });
    const shownBottom = (el) => el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
    const overflow = (el) => el.scrollHeight - el.clientHeight;
    const mixer = document.querySelector("#mixer");
    const waves = document.querySelector("#wave-scroll");
    return {
      rows: edges(".mixer-column .lane-header:not(.hidden)"),
      lanes: edges(".stem-waveform-row:not(.hidden)"),
      mixerBottom: shownBottom(mixer),
      wavesBottom: shownBottom(waves),
      overflow: [overflow(mixer), overflow(waves)],
      wavesScrollX: waves.scrollWidth > waves.clientWidth,
    };
  });
}

async function wheelMixerToBottom(page) {
  const box = await page.locator("#mixer").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < WHEEL_STEPS; step++) await page.mouse.wheel(0, WHEEL_STEP_PX);
  await page.waitForTimeout(SETTLE_MS);
}

async function zoomInOnWaves(page) {
  const box = await page.locator("#wave-scroll").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < ZOOM_IN_STEPS; step++) await page.mouse.wheel(0, ZOOM_IN_DELTA);
  await page.waitForTimeout(SETTLE_MS);
}

function expectRowsBesideLanes(g) {
  expect(g.lanes).toHaveLength(g.rows.length);
  const drift = g.rows.map((row, i) => Math.abs(row.top - g.lanes[i].top));
  expect(Math.max(...drift)).toBeLessThanOrEqual(ALIGN_TOLERANCE_PX);
}

test.describe("lanes beside a waveform pane with a horizontal scrollbar", () => {
  test("on a short window the last lane scrolls fully into view beside its mixer row", async ({ page }) => {
    await openSixStemStudio(page, SHORT_WINDOW);
    expect((await laneGeometry(page)).wavesScrollX).toBe(true);

    await wheelMixerToBottom(page);
    const g = await laneGeometry(page);
    expect(g.rows.at(-1).bottom).toBeLessThanOrEqual(g.mixerBottom + ALIGN_TOLERANCE_PX);
    expect(g.lanes.at(-1).bottom).toBeLessThanOrEqual(g.wavesBottom + ALIGN_TOLERANCE_PX);
    expectRowsBesideLanes(g);
  });

  test("a window tall enough for every lane scrolls neither column", async ({ page }) => {
    await openSixStemStudio(page, TALL_WINDOW);
    expect((await laneGeometry(page)).overflow).toEqual([0, 0]);
  });

  test("zooming in on a tall window keeps every lane in view and in line", async ({ page }) => {
    await openSixStemStudio(page, TALL_WINDOW);

    await zoomInOnWaves(page);
    const g = await laneGeometry(page);
    expect(g.wavesScrollX).toBe(true);
    expect(g.overflow).toEqual([0, 0]);
    expectRowsBesideLanes(g);
  });
});
